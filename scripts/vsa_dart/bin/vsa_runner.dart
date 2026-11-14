// VSA 薄 Dart runner
//
// 基于 venera_core 在真实 QuickJS 运行时内完成:
//   1. 加载仓库原始漫画源 JS
//   2. 调用源自身的 loadComicPages 获取图片列表
//   3. 调用源自身的 getImageLoadingConfig(即 JS onImageLoad)获取动态请求头
//   4. 用该请求头实际下载首图并输出 magic bytes / sha256
//
// 这补齐了 CLI `pages` 只返回 URL、无法携带 onImageLoad 动态头的缺口。
//
// 用法:
//   dart run bin/vsa_runner.dart --data <dir> --load <source.js> \
//     --key <sourceKey> --comic-id <id> --ep-id <id>
//
// 输出 JSON:
//   {"ok": true, "images_count": n, "image_urls": [...], "verify": {...}}
//   {"ok": false, "error": "..."}
import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:venera_core/venera_core.dart';

String identifyImage(List<int> head) {
  final b = head;
  bool startsWith(List<int> prefix) {
    if (b.length < prefix.length) return false;
    for (var i = 0; i < prefix.length; i++) {
      if (b[i] != prefix[i]) return false;
    }
    return true;
  }

  if (startsWith([0xff, 0xd8, 0xff])) return 'JPEG';
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'PNG';
  if (startsWith('RIFF'.codeUnits) && b.length >= 12 && b[8] == 0x57 && b[9] == 0x45 && b[10] == 0x42 && b[11] == 0x50) {
    return 'WebP';
  }
  if (startsWith('GIF8'.codeUnits)) return 'GIF';
  // ISOBMFF ftyp box: [size(4)][ftyp(4)] — AVIF/HEIF 容器
  if (b.length >= 8 && b[4] == 0x66 && b[5] == 0x74 && b[6] == 0x79 && b[7] == 0x70) {
    return 'AVIF';
  }
  final ascii = String.fromCharCodes(b.take(64)).toLowerCase();
  if (ascii.contains('<html') || ascii.contains('<!doctype')) return 'HTML(非图片)';
  return '未知(${b.take(8).map((e) => e.toRadixString(16).padLeft(2, '0')).join()})';
}

Future<void> main(List<String> arguments) async {
  String? dataPath;
  String? loadFile;
  String? key;
  String? comicId;
  String? epId;
  for (var i = 0; i < arguments.length - 1; i++) {
    switch (arguments[i]) {
      case '--data':
        dataPath = arguments[i + 1];
      case '--load':
        loadFile = arguments[i + 1];
      case '--key':
        key = arguments[i + 1];
      case '--comic-id':
        comicId = arguments[i + 1];
      case '--ep-id':
        epId = arguments[i + 1];
    }
  }
  if (dataPath == null || loadFile == null || key == null || comicId == null || epId == null) {
    stderr.writeln('usage: vsa_runner --data <dir> --load <js> --key <key> --comic-id <id> --ep-id <id>');
    exit(64);
  }

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
      stdout.writeln(jsonEncode(out));
      exit(1);
    }
    final images = (pages.data ?? const <String>[])
        .whereType<String>()
        .where((u) => u.startsWith('http'))
        .toList();
    out['ok'] = true;
    out['images_count'] = images.length;
    out['image_urls'] = images.take(3).toList();
    if (images.isEmpty) {
      out['error'] = 'No images';
      stdout.writeln(jsonEncode(out));
      exit(1);
    }

    // 首图: 通过源自身的 onImageLoad 获取动态请求头后实抓字节
    final imageUrl = images.first;
    Map<String, dynamic> headerConfig = {};
    try {
      final cfg = await target.getImageLoadingConfig?.call(imageUrl, comicId, epId);
      if (cfg != null) {
        headerConfig = cfg;
      }
    } catch (e) {
      out['image_config_error'] = '$e';
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
    final head = bytes.length > 64 ? bytes.sublist(0, 64) : bytes;
    out['verify'] = {
      'url': fetchUrl.split('?').first,
      'status': response.statusCode,
      'magic': identifyImage(head),
      'size': bytes.length,
      'headers_used': headers.keys.toList(),
    };
    stdout.writeln(jsonEncode(out));
    exit(response.statusCode == 200 ? 0 : 1);
  } catch (e, s) {
    out['ok'] = false;
    out['error'] = '$e';
    out['stack'] = s.toString().split('\n').take(4).join('\n');
    stdout.writeln(jsonEncode(out));
    exit(1);
  }
}
