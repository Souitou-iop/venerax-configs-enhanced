#!/usr/bin/env python3
"""
VeneraX Comic Sources Automated Health Check Script
Tests endpoint connectivity and basic responsiveness for all curated sources in index.json.
"""

import json
import os
import sys
import urllib.request
import time
import hmac
import hashlib
import uuid
from datetime import datetime, timezone, timedelta

def get_pica_headers():
    path = "init"
    method = "GET"
    nonce = uuid.uuid4().hex
    t = str(int(time.time()))
    api_key = "C69BAF41DA5ABD1FFEDC6D2FEA56B"
    raw_data = (path + t + nonce + method + api_key).lower()
    secret = '~d}$Q7$eIni=V)9\\RK/P.RM4;9[7|@/CA}b~OW!3?EV`:<>M7pddUBL5n|0/*Cn'
    signature = hmac.new(secret.encode('utf-8'), raw_data.encode('utf-8'), hashlib.sha256).hexdigest()
    return {
        "api-key": api_key,
        "accept": "application/vnd.picacomic.com.v1+json",
        "app-channel": "3",
        "app-platform": "android",
        "app-build-version": "45",
        "Content-Type": "application/json; charset=UTF-8",
        "user-agent": "okhttp/3.8.1",
        "version": "v1.5.4",
        "time": t,
        "nonce": nonce,
        "signature": signature,
        "http_client": "dart:io"
    }


def get_dual_time_str(include_seconds=False):
    now_utc = datetime.now(timezone.utc)
    bj_tz = timezone(timedelta(hours=8))
    now_bj = datetime.now(bj_tz)
    fmt = "%Y-%m-%d %H:%M:%S" if include_seconds else "%Y-%m-%d %H:%M"
    bj_str = now_bj.strftime(fmt)
    utc_str = now_utc.strftime(fmt)
    return f"`{bj_str} (北京时间 / UTC+8)` · `[{utc_str} (GitHub Actions 宿主原生 UTC 时区)]`"

def check_source(source):
    key = source.get('key')
    name = source.get('name')
    version = source.get('version', '1.0.0')
    
    # Accurate endpoint probes for the 15 curated sources
    targets = {
        'copy_manga': ('https://api.copy2000.online/api/v3/system/network2?platform=3', 'GET', {'User-Agent': 'COPY/3.0.9', 'source': 'copyApp'}, None),
        'Komiic': ('https://komiic.com/api/query', 'POST', {'User-Agent': 'Mozilla/5.0', 'Referer': 'https://komiic.com/', 'Content-Type': 'application/json'}, json.dumps({'operationName': 'allCategory', 'variables': {}, 'query': 'query allCategory { allCategory { id name } }'}).encode('utf-8')),
        'manga_dex': ('https://api.mangadex.org/manga?limit=1&hasAvailableChapters=true', 'GET', {'User-Agent': 'VeneraX-health-check/1.0'}, None),
        'zaimanhua': ('https://www.zaimanhua.com/', 'GET', {'User-Agent': 'Mozilla/5.0'}, None),
        'baozi': ('https://baozimhcn.com/', 'GET', {'User-Agent': 'Mozilla/5.0'}, None),
        'picacg': ('https://picaapi.picacomic.com/init', 'GET', get_pica_headers(), None),
        'jm': ('https://rup4a04-c02.tos-cn-hongkong.bytepluses.com/newsvr-2025.txt', 'GET', {'User-Agent': 'Mozilla/5.0'}, None),
        'ehentai': ('https://api.e-hentai.org/api.php', 'POST', {'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0'}, json.dumps({'method': 'gdata', 'gidlist': [[3380000, 'a1b2c3d4e5']]}).encode('utf-8')),
        'nhentai': ('https://nhentai.net/api/v2/search?query=chinese&page=1&sort=date', 'GET', {'User-Agent': 'Mozilla/5.0', 'Referer': 'https://nhentai.net/'}, None),
        'hitomi': ('https://hitomi.la/', 'GET', {'User-Agent': 'Mozilla/5.0'}, None),
        'wnacg': ('https://www.wnacg.com/', 'GET', {'User-Agent': 'Mozilla/5.0'}, None),
        'manhuaren': ('https://www.manhuaren.com/', 'GET', {'User-Agent': 'Mozilla/5.0'}, None),
        'ikmmh': ('https://www.ikamn.com/', 'GET', {'User-Agent': 'Mozilla/5.0'}, None),
        'ManHuaGui': ('https://manhuagui.com/', 'GET', {'User-Agent': 'Mozilla/5.0'}, None),
        'shonen_jump_plus': ('https://shonenjumpplus.com/api/v1/user_account/access_token', 'POST', {'Origin': 'https://shonenjumpplus.com', 'Referer': 'https://shonenjumpplus.com/', 'X-Giga-Device-Id': '0123456789abcdef', 'User-Agent': 'ShonenJumpPlus-Android/4.3.0'}, b''),
        'comic_walker': ('https://mobileapp.comic-walker.com/v1/users', 'POST', {'X-API-Environment-Key': 'ytBrdQ2ZYdRQguqEusVLxQVUgakNnVht', 'User-Agent': 'BookWalkerApp/1.6.3 (Android 13)', 'Content-Type': 'application/json'}, b''),
        'ccc': ('https://api.creative-comic.tw/public/home_v2', 'GET', {'User-Agent': 'Mozilla/5.0', 'device': 'web_desktop', 'uuid': 'null'}, None),
    }
    
    target_info = targets.get(key)
    if not target_info:
        return {'key': key, 'name': name, 'version': version, 'status': '⚪ 未配置探测', 'code': '-', 'latency': '-'}
    
    url, method, headers, data = target_info
    
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    start_time = time.time()
    try:
        with urllib.request.urlopen(req, timeout=6) as resp:
            latency = int((time.time() - start_time) * 1000)
            if resp.status in [200, 201, 206]:
                return {'key': key, 'name': name, 'version': version, 'status': '🟢 正常 (Healthy)', 'code': resp.status, 'latency': f'{latency}ms'}
            else:
                return {'key': key, 'name': name, 'version': version, 'status': '🟡 响应异常', 'code': resp.status, 'latency': f'{latency}ms'}
    except urllib.error.HTTPError as e:
        latency = int((time.time() - start_time) * 1000)
        if e.code in [401, 403, 210]:
            return {'key': key, 'name': name, 'version': version, 'status': '🟡 需鉴权/CF保护', 'code': e.code, 'latency': f'{latency}ms'}
        return {'key': key, 'name': name, 'version': version, 'status': '🔴 异常', 'code': e.code, 'latency': f'{latency}ms'}
    except Exception as e:
        return {'key': key, 'name': name, 'version': version, 'status': '🔴 连接失败', 'code': 'ERR', 'latency': '-'}

def main():
    root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    index_path = os.path.join(root_dir, 'index.json')
    if not os.path.exists(index_path):
        index_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'index.json')
    
    if not os.path.exists(index_path):
        print(f"Error: {index_path} not found")
        sys.exit(1)
        
    with open(index_path, 'r', encoding='utf-8') as f:
        sources = json.load(f)
        
    print(f"Starting Health Check for {len(sources)} curated comic sources...\n")
    results = []
    
    for s in sources:
        res = check_source(s)
        results.append(res)
        print(f"  [{res['status']}] {res['name']:18} ({res['key']:16}) -> Code: {res['code']}, Latency: {res['latency']}")
        time.sleep(0.1)
        
    # Generate summary markdown table
    md = "# 🩺 漫画源实时健康探活报告 (Source Health Report)\n\n"
    dual_now = get_dual_time_str(True)
    md += f"最后检测时间：{dual_now}\n\n"

    md += "| 漫画源 | Key | 脚本版本 | 运行状态 | HTTP状态码 | 响应延迟 |\n"
    md += "| :--- | :--- | :---: | :---: | :---: | :---: |\n"
    
    for r in results:
        md += f"| **{r['name']}** | `{r['key']}` | `{r['version']}` | {r['status']} | `{r['code']}` | `{r['latency']}` |\n"
        
    summary_file = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary_file:
        with open(summary_file, 'a', encoding='utf-8') as f:
            f.write(md)
            
    print("\nHealth check finished successfully.")

if __name__ == '__main__':
    main()
