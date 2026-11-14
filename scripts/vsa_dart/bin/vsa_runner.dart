// VSA 薄 Dart runner
//
// 基于 venera_core 在真实 QuickJS 运行时内完成:
//   1. 加载仓库原始漫画源 JS
//   2. 调用源自身的 loadComicPages 获取图片列表
//   3. 对抽样图片逐张调用源自身的 getImageLoadingConfig(即 JS onImageLoad)获取动态请求头
//   4. 用该请求头实际下载样本图片, 输出 magic bytes / 字节数 / 解码结果 / sha256
//
// 这补齐了 CLI `pages` 只返回 URL、无法携带 onImageLoad 动态头的缺口。
//
// 用法:
//   dart run bin/vsa_runner.dart --data <dir> --load <source.js> \
//     --key <sourceKey> --comic-id <id> --ep-id <id> [--count n] [--allow-local]
//
// 输出 JSON(单行):
//   {"ok": true, "requested_image_count": n, "available_image_count": m,
//    "attempted_image_count": k, "verified_image_count": j,
//    "image_urls": [...], "samples": [{...}], ...}
//   {"ok": false, "error": "...", "error_code": "..."}
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:dio/dio.dart';
import 'package:image/image.dart' as imglib;
import 'package:venera_core/venera_core.dart';

String identifyImage(Uint8List head) {
  bool startsWith(List<int> prefix) {
    if (head.length < prefix.length) return false;
    for (var i = 0; i < prefix.length; i++) {
      if (head[i] != prefix[i]) return false;
    }
    return true;
  }

  if (startsWith([0xff, 0xd8, 0xff])) return 'JPEG';
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'PNG';
  if (startsWith('RIFF'.codeUnits) && head.length >= 12 && head[8] == 0x57 && head[9] == 0x45 && head[10] == 0x42 && head[11] == 0x50) {
    return 'WebP';
  }
  if (startsWith('GIF8'.codeUnits)) return 'GIF';
  // ISOBMFF ftyp box: [size(4)][ftyp(4)] — AVIF/HEIF 容器
  if (head.length >= 8 && head[4] == 0x66 && head[5] == 0x74 && head[6] == 0x79 && head[7] == 0x70) {
    return 'AVIF';
  }
  final ascii = String.fromCharCodes(head.take(64)).toLowerCase();
  if (ascii.contains('<html') || ascii.contains('<!doctype')) return 'HTML(非图片)';
  return '未知(${head.take(8).map((e) => e.toRadixString(16).padLeft(2, '0')).join()})';
}

/// URL 安全护栏: 仅允许 http/https 公网目标; 阻止内网/环回/云元数据地址(SSRF)。
/// [allowLocal] 仅供离线 Fixture 模式(本地 127.0.0.1 服务)使用。
String? guardUrl(String url, {bool allowLocal = false}) {
  Uri uri;
  try {
    uri = Uri.parse(url);
  } catch (_) {
    return 'URL 无法解析';
  }
  if (uri.scheme != 'http' && uri.scheme != 'https') {
    return '非 http/https 协议: ${uri.scheme}';
  }
  if (uri.host.isEmpty) {
    return 'URL 缺少主机名';
  }
  final host = uri.host.toLowerCase();
  final isLocal = host == 'localhost' || host == '127.0.0.1' || host == '::1' || host.endsWith('.local');
  if (isLocal && !allowLocal) {
    return '拒绝访问本地地址: $host';
  }
  // 云元数据地址一律拒绝
  if (host == '169.254.169.254' || host == 'metadata.google.internal') {
    return '拒绝访问云元数据地址';
  }
  // 解析主机为 IP 时拒绝私网段(10/172.16-31/192.168/169.254/0.0.0.0)
  final ip = Uri.tryParse('http://$host')?.host ?? host;
  final ipPattern = RegExp(r'^\d{1,3}(\.\d{1,3}){3}$');
  if (ipPattern.hasMatch(ip)) {
    final parts = ip.split('.').map((e) => int.tryParse(e) ?? -1).toList();
    final private = (parts[0] == 10) ||
        (parts[0] == 192 && parts[1] == 168) ||
        (parts[0] == 169 && parts[1] == 254) ||
        (parts[0] == 172 && parts[1] >= 16 && parts[1] <= 31) ||
        parts.every((e) => e == 0);
    if (private && !allowLocal) {
      return '拒绝访问私网地址: $ip';
    }
  }
  return null;
}

Future<void> main(List<String> arguments) async {
  String? dataPath;
  String? loadFile;
  String? key;
  String? comicId;
  String? epId;
  var count = 2;
  var allowLocal = false;
  for (var i = 0; i < arguments.length; i++) {
    switch (arguments[i]) {
      case '--data':
        dataPath = arguments[++i];
      case '--load':
        loadFile = arguments[++i];
      case '--key':
        key = arguments[++i];
      case '--comic-id':
        comicId = arguments[++i];
      case '--ep-id':
        epId = arguments[++i];
      case '--count':
        count = int.tryParse(arguments[++i]) ?? 2;
      case '--allow-local':
        allowLocal = true;
    }
  }
  if (dataPath == null || loadFile == null || key == null || comicId == null || epId == null) {
    stderr.writeln('usage: vsa_runner --data <dir> --load <js> --key <key> --comic-id <id> --ep-id <id> [--count n] [--allow-local]');
    exit(64);
  }
  if (count < 1) count = 1;

  final out = <String, dynamic>{};
  try {
    final dataDir = Directory(dataPath);
    if (!await dataDir.exists()) {
      await dataDir.create(recursive: true);
    }
    // 自建 Dio 并交给 venera_core: JS 网络桥与本 runner 的图片抓取共享同一 cookie jar
    final dio = Dio();
    await ComicSourceManager().init(
      dataPath: dataPath,
      appVersion: '2.0.0',
      dio: dio,
    );
    final source = await ComicSourceManager().installFromFile(loadFile, replace: true);
    if (source.key != key) {
      // key 与参数不一致时以实际加载为准记录
      out['loaded_key'] = source.key;
    }
    final target = ComicSourceManager().find(key) ?? source;

    final pages = await target.loadComicPages!(comicId, epId);
    if (pages.error) {
      out['ok'] = false;
      out['error'] = 'loadEp: ${pages.errorMessage ?? 'unknown error'}';
      out['error_code'] = 'SOURCE_PAGES_ERROR';
      stdout.writeln(jsonEncode(out));
      exit(1);
    }
    final images = (pages.data ?? const <String>[])
        .whereType<String>()
        .where((u) => u.startsWith('http'))
        .toList();
    out['available_image_count'] = images.length;
    out['image_urls'] = images.take(3).toList();
    if (images.isEmpty) {
      out['ok'] = false;
      out['error'] = 'No images';
      out['error_code'] = 'SOURCE_PAGES_EMPTY';
      stdout.writeln(jsonEncode(out));
      exit(1);
    }

    // 抽样验证: 逐张调用源自身的 onImageLoad 获取动态请求头后实抓字节
    final requested = count;
    final samples = images.take(requested).toList();
    final sampleResults = <Map<String, dynamic>>[];
    var verified = 0;
    var decodeSupported = 0;
    for (var i = 0; i < samples.length; i++) {
      final imageUrl = samples[i];
      final sample = <String, dynamic>{'index': i};
      Map<String, dynamic> headerConfig = {};
      try {
        final cfg = await target.getImageLoadingConfig?.call(imageUrl, comicId, epId);
        if (cfg != null) {
          headerConfig = cfg;
        }
      } catch (e) {
        sample['image_config_error'] = '$e';
      }
      final headers = <String, String>{};
      final rawHeaders = headerConfig['headers'];
      if (rawHeaders is Map) {
        rawHeaders.forEach((k, v) => headers[k.toString()] = v.toString());
      }
      String fetchUrl = imageUrl;
      if (headerConfig['url'] is String && (headerConfig['url'] as String).isNotEmpty) {
        fetchUrl = headerConfig['url'] as String;
      }
      if (!headers.containsKey('User-Agent') || headers['User-Agent']!.isEmpty) {
        headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
            '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
      }
      final guard = guardUrl(fetchUrl, allowLocal: allowLocal);
      if (guard != null) {
        sample.addAll({
          'url': fetchUrl.split('?').first,
          'status': 'BLOCKED',
          'magic': 'SSRF',
          'error': guard,
          'verified': false,
        });
        sampleResults.add(sample);
        break; // 安全护栏命中, 不继续抓取
      }
      try {
        final response = await dio.get<List<int>>(
          fetchUrl,
          options: Options(
            headers: headers,
            responseType: ResponseType.bytes,
            validateStatus: (_) => true,
            followRedirects: true,
          ),
        );
        final bytes = response.data ?? const <int>[];
        final magic = identifyImage(Uint8List.fromList(bytes.isEmpty ? List<int>.filled(0, 0) : bytes));
        sample['url'] = fetchUrl.split('?').first;
        sample['status'] = response.statusCode;
        sample['magic'] = magic;
        sample['size'] = bytes.length;
        sample['sha256'] = bytes.isEmpty
            ? ''
            : sha256.convert(bytes.take(1 << 20).toList()).toString();
        final decodable = magic == 'JPEG' || magic == 'PNG' || magic == 'GIF' ||
            (magic == 'WebP' && bytes.length > 12 && bytes[12] == 0x56 && bytes[13] == 0x50);
        if (response.statusCode == 200 && magic != 'HTML(非图片)' && !magic.startsWith('未知') && bytes.isNotEmpty) {
          // 完整解码验证; AVIF 等不支持解码的格式记录"字节可信但未解码"
          if (decodable) {
            try {
              final decoded = imglib.decodeImage(Uint8List.fromList(bytes));
              sample['decoded'] = decoded != null;
              sample['width'] = decoded?.width;
              sample['height'] = decoded?.height;
              decodeSupported++;
              if (decoded == null) {
                sample['verified'] = false;
                sample['error'] = 'IMAGE_DECODE_FAILED';
                sampleResults.add(sample);
                break;
              }
            } catch (e) {
              sample['decoded'] = false;
              sample['verified'] = false;
              sample['error'] = 'IMAGE_DECODE_FAILED: $e';
              sampleResults.add(sample);
              break;
            }
          } else {
            sample['decoded'] = null;
            sample['note'] = '字节格式可信但运行时无解码器, 未执行解码';
          }
          sample['verified'] = true;
          verified++;
        } else {
          sample['verified'] = false;
          if (magic == 'HTML(非图片)') {
            sample['error'] = 'IMAGE_HTML_INSTEAD_OF_IMAGE';
          } else if (bytes.isEmpty) {
            sample['error'] = 'IMAGE_EMPTY';
          }
          sampleResults.add(sample);
          break;
        }
      } catch (e) {
        sample['verified'] = false;
        sample['status'] = 'ERR';
        sample['error'] = '$e';
        sampleResults.add(sample);
        break;
      }
      sampleResults.add(sample);
    }

    out['ok'] = verified > 0;
    out['requested_image_count'] = requested;
    out['attempted_image_count'] = sampleResults.length;
    out['verified_image_count'] = verified;
    out['decoded_image_count'] = decodeSupported;
    out['samples'] = sampleResults;
    stdout.writeln(jsonEncode(out));
    exit(verified > 0 ? 0 : 1);
  } catch (e, s) {
    out['ok'] = false;
    out['error'] = '$e';
    out['error_code'] = 'RUNNER_EXCEPTION';
    out['stack'] = s.toString().split('\n').take(4).join('\n');
    stdout.writeln(jsonEncode(out));
    exit(1);
  }
}

