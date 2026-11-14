// VSA 薄 Dart runner
//
// 基于 venera_core 在真实 QuickJS 运行时内完成:
//   1. 加载仓库原始漫画源 JS
//   2. 调用源自身的 loadComicPages 获取图片列表
//   3. 对抽样图片逐张调用源自身的 getImageLoadingConfig(即 JS onImageLoad)获取动态请求头
//   4. 用该请求头实际下载样本图片, 输出 magic bytes / 字节数 / 解码结果 / sha256
//
// 出站安全(P0-A):
//   - 自建 Dio 注入 venera_core: JS 网络桥与本 runner 共享同一实例与 cookie jar;
//   - 拦截器对 **JS 网络桥的全部初始请求** 做 URL/DNS 护栏;
//   - 本 runner 的图片抓取 followRedirects=false + 手动逐跳跟随, 每一跳重走护栏;
//   - 已知残余风险(如实声明, 详见 docs/vsa.md): DNS 校验与实际连接之间的 TOCTOU 窗口;
//     Dio 层重定向对 JS 桥请求仍由库内部跟随(初始 URL 已护栏, 跳转目标未重校验);
//     全链路出站隔离需进程/网络层沙箱, 本轮未实现。
//
// 用法:
//   dart run bin/vsa_runner.dart --data <dir> --load <source.js> \
//     --key <sourceKey> --comic-id <id> --ep-id <id> [--count n] [--allow-local]
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
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

/// 判断单个 IP 地址是否属于禁止访问段(环回/私网/链路本地/未指定/CGNAT)。
/// 覆盖 IPv4、IPv6(含 ULA fc00::/7、link-local fe80::/10、loopback ::1)与
/// IPv4-mapped IPv6(::ffff:a.b.c.d)。
bool isForbiddenIp(InternetAddress addr) {
  if (addr.isLoopback || addr.isLinkLocal || addr.isMulticast) {
    return true;
  }
  final bytes = addr.rawAddress;
  if (bytes.length == 4) {
    final a = bytes[0], b = bytes[1];
    if (a == 10 || a == 127 || a == 0) return true;
    if (a == 172 && b >= 16 && b <= 31) return true;
    if (a == 192 && b == 168) return true;
    if (a == 169 && b == 254) return true;
    if (a == 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (bytes.length == 16) {
    // IPv4-mapped ::ffff:0:0/96 → 按内嵌 IPv4 重新判定
    if (bytes[10] == 0xff && bytes[11] == 0xff) {
      final v4 = InternetAddress.fromRawAddress(
          Uint8List.fromList(bytes.sublist(12)), type: InternetAddressType.IPv4);
      return isForbiddenIp(v4);
    }
    if (bytes[0] == 0xfc || bytes[0] == 0xfd) return true; // ULA
    if (bytes[0] == 0xfe && (bytes[1] & 0xc0) == 0x80) return true; // link-local
    if (bytes.every((e) => e == 0)) return true; // :: 未指定地址
    return false;
  }
  return false;
}

/// URL 字符串护栏: scheme/host/userinfo。
String? guardUrl(String url) {
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
  if (uri.userInfo.isNotEmpty) {
    return 'URL 携带用户信息(禁止)';
  }
  return null;
}

/// DNS/主机护栏: 校验主机名解析结果的每一个 IP(含 IPv6/mapped)。
/// 返回 null 表示通过; 否则返回脱敏拒绝原因。
Future<String?> guardHost(String host, {bool allowLocal = false}) async {
  final h = host.toLowerCase();
  if (h == '169.254.169.254' || h == 'metadata.google.internal') {
    return '拒绝访问云元数据地址';
  }
  if (h == 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) {
    if (!allowLocal) return '拒绝访问本地/内部主机名: $host';
    return null;
  }
  final literal = InternetAddress.tryParse(host);
  if (literal != null) {
    if (isForbiddenIp(literal) && !allowLocal) {
      return '拒绝访问私网/环回地址: $host';
    }
    return null;
  }
  final addresses = await InternetAddress.lookup(host, type: InternetAddressType.any);
  if (addresses.isEmpty) {
    return 'DNS 解析无结果: $host';
  }
  for (final addr in addresses) {
    if (isForbiddenIp(addr) && !allowLocal) {
      return 'DNS 解析命中禁段地址: $host → ${addr.address}';
    }
  }
  return null;
}

/// 带 URL/DNS 护栏的 GET: 手动逐跳跟随重定向, 每一跳重走护栏。
Future<Response<List<int>>> guardedGet(
    Dio dio, String url, Map<String, String> headers,
    {bool allowLocal = false, int maxHops = 5}) async {
  var current = url;
  for (var hop = 0; hop <= maxHops; hop++) {
    final urlErr = guardUrl(current);
    if (urlErr != null) {
      throw DioException.connectionError(
          requestOptions: RequestOptions(path: current), reason: 'URL_GUARD: $urlErr');
    }
    final hostErr = await guardHost(Uri.parse(current).host, allowLocal: allowLocal);
    if (hostErr != null) {
      throw DioException.connectionError(
          requestOptions: RequestOptions(path: current), reason: 'DNS_GUARD: $hostErr');
    }
    final response = await dio.get<List<int>>(
      current,
      options: Options(
        headers: headers,
        responseType: ResponseType.bytes,
        validateStatus: (_) => true,
        followRedirects: false,
        maxRedirects: 0,
      ),
    );
    final code = response.statusCode ?? 0;
    if (code >= 300 && code < 400 && code != 304) {
      final location = response.headers.value('location');
      if (location == null) return response;
      current = Uri.parse(current).resolve(location).toString();
      continue;
    }
    return response;
  }
  throw DioException.connectionError(
      requestOptions: RequestOptions(path: url), reason: 'URL_GUARD: 重定向次数超过 $maxHops');
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
    // 自建 Dio 注入 venera_core: JS 网络桥与本 runner 共享同一实例/cookie jar。
    // 拦截器覆盖 **JS 网络桥的全部初始请求**(URL + DNS 护栏)。
    final dio = Dio();
    dio.interceptors.add(InterceptorsWrapper(
      onRequest: (options, handler) async {
        final err = guardUrl(options.uri.toString());
        if (err != null) {
          handler.reject(DioException.connectionError(
              requestOptions: options, reason: 'URL_GUARD: $err'));
          return;
        }
        final hostErr = await guardHost(options.uri.host, allowLocal: allowLocal);
        if (hostErr != null) {
          handler.reject(DioException.connectionError(
              requestOptions: options, reason: 'DNS_GUARD: $hostErr'));
          return;
        }
        handler.next(options);
      },
    ));
    await ComicSourceManager().init(
      dataPath: dataPath,
      appVersion: '2.0.0',
      dio: dio,
    );
    final source = await ComicSourceManager().installFromFile(loadFile, replace: true);
    if (source.key != key) {
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
    var decoded = 0;
    var decodeUnsupported = 0;
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
      try {
        final response = await guardedGet(dio, fetchUrl, headers, allowLocal: allowLocal);
        final bytes = response.data!;
        final magic = identifyImage(Uint8List.fromList(bytes));
        sample['url'] = fetchUrl.split('?').first;
        sample['status'] = response.statusCode;
        sample['magic'] = magic;
        sample['size'] = bytes.length;
        sample['sha256'] =
            bytes.isEmpty ? '' : sha256.convert(bytes.take(1 << 20).toList()).toString();
        final okStatus = response.statusCode == 200 && bytes.isNotEmpty;
        final trustedImage = magic != 'HTML(非图片)' && !magic.startsWith('未知');
        if (!okStatus || !trustedImage) {
          sample['verified'] = false;
          sample['error'] = !okStatus
              ? 'IMAGE_HTTP_ERROR'
              : (magic == 'HTML(非图片)' ? 'IMAGE_HTML_INSTEAD_OF_IMAGE' : 'IMAGE_UNRECOGNIZED');
          sampleResults.add(sample);
          break;
        }
        final decodable = magic == 'JPEG' || magic == 'PNG' || magic == 'GIF' ||
            (magic == 'WebP' && bytes.length > 12 && bytes[12] == 0x56 && bytes[13] == 0x50);
        if (decodable) {
          try {
            final decodedImg = imglib.decodeImage(Uint8List.fromList(bytes));
            sample['decoded'] = decodedImg != null;
            sample['width'] = decodedImg?.width;
            sample['height'] = decodedImg?.height;
            if (decodedImg == null) {
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
          decoded++;
        } else {
          // AVIF 等无解码器格式: 字节签名可信, 如实记录未执行解码
          sample['decoded'] = null;
          sample['note'] = '字节格式可信但运行时无解码器, 未执行解码';
          decodeUnsupported++;
        }
        sample['verified'] = true;
        verified++;
      } catch (e) {
        final reason = '$e';
        sample['verified'] = false;
        sample['status'] = 'ERR';
        sample['error'] = reason.startsWith('URL_GUARD') || reason.startsWith('DNS_GUARD')
            ? 'URL_GUARD_REJECTED'
            : 'IMAGE_FETCH_ERROR';
        sample['error_detail'] = reason;
        sampleResults.add(sample);
        break;
      }
      sampleResults.add(sample);
    }

    out['ok'] = verified > 0;
    out['requested_image_count'] = requested;
    out['attempted_image_count'] = sampleResults.length;
    out['verified_image_count'] = verified;
    out['decoded_image_count'] = decoded;
    out['unsupported_decode_count'] = decodeUnsupported;
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
