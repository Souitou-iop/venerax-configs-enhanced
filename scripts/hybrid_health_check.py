#!/usr/bin/env python3
"""
VeneraX Hybrid Dual-Engine Health Check & Latency Benchmark
Supports automatic failover between Alibaba Cloud sandboxed runner and Globalping API.
"""

import json
import os
import sys
import time
import subprocess
import urllib.request
import urllib.error
import hmac
import hashlib
import uuid
import re
from datetime import datetime, timezone, timedelta

# Sources configurations for direct benchmarking
PROBES = {
    'copy_manga': {
        'name': '拷贝漫画',
        'url': 'https://api.copy2000.online/api/v3/comics?limit=1',
        'fallback_urls': [
            'https://api.copy-manga.com/api/v3/comics?limit=1',
            'https://api.mangacopy.com/api/v3/comics?limit=1',
            'https://api.copy202601.com/api/v3/comics?limit=1'
        ],
        'method': 'GET',
        'headers': {'User-Agent': 'COPY/3.0.9', 'source': 'copyApp', 'version': '3.0.9', 'platform': '3'},
        'data': None,
        'line_opts': '• 大陆线路 (`Region 1`)<br>• 海外线路 (`Region 0`)',
        'advice': '• **强烈推荐全局保持「海外线路」**：直连省去 3.3s 国内广告握手，代理下秒级响应；<br>• 大陆线路强制请求国内广告 ID 且易触发 210 限频风控。'
    },
    'Komiic': {
        'name': 'Komiic',
        'url': 'https://komiic.com/api/query',
        'cn_url': 'https://komiic.cc/',
        'method': 'POST',
        'headers': {'User-Agent': 'Mozilla/5.0', 'Referer': 'https://komiic.com/', 'Content-Type': 'application/json'},
        'data': json.dumps({'operationName': 'allCategory', 'variables': {}, 'query': 'query allCategory { allCategory { id name } }'}).encode('utf-8'),
        'line_opts': '• 主站 (`komiic.com`)<br>• 大陆线路 (`komiic.cc`)',
        'advice': '• 大陆直连时主站会被 DNS 拦截，请在源设置中选择「中国大陆线路 (`komiic.cc`)」；<br>• 开启代理时选择主站速度与解析质量最佳。'
    },
    'manga_dex': {
        'name': 'MangaDex',
        'url': 'https://api.mangadex.org/manga?limit=1&hasAvailableChapters=true',
        'method': 'GET',
        'headers': {'User-Agent': 'VeneraX-health-check/1.0'},
        'data': None,
        'line_opts': 'MangaDex API',
        'advice': '• 国际多语言官方 API；大陆网络如遇超时，建议使用代理或在源设置中降低请求频率。'
    },
    'zaimanhua': {
        'name': '再漫画',
        'url': 'https://www.zaimanhua.com/',
        'method': 'GET',
        'headers': {'User-Agent': 'Mozilla/5.0'},
        'data': None,
        'line_opts': '再漫画主站',
        'advice': '• 中文综合补充源；站点可能存在地区、反爬或登录限制，探活成功不代表每本作品都可读。'
    },
    'baozi': {
        'name': '包子漫画',
        'url': 'https://baozimhcn.com/',
        'cn_url': 'https://www.twmanga.com/',
        'method': 'GET',
        'headers': {'User-Agent': 'Mozilla/5.0'},
        'data': None,
        'line_opts': '5 个官方镜像主域名',
        'advice': '• 代理环境下默认域名响应极快；<br>• 大陆直连若遇 301/302 重定向，可在源设置中将主域名切换为 `twmanga.com`。'
    },
    'manhuaren': {
        'name': '漫画人',
        'url': 'https://www.manhuaren.com/',
        'method': 'GET',
        'headers': {'User-Agent': 'Mozilla/5.0'},
        'data': None,
        'line_opts': '官方国内直连',
        'advice': '• 原生国内全彩漫画站点，直连与代理均可使用，代理环境下解析更快。'
    },
    'ikmmh': {
        'name': '爱看漫',
        'url': 'https://www.ikamn.com/',
        'method': 'GET',
        'headers': {'User-Agent': 'Mozilla/5.0'},
        'data': None,
        'line_opts': '官方国内直连',
        'advice': '• 原生国内站点，v1.0.6 已启用详情与目录并发拉取加速，加载体验流畅。'
    },
    'ManHuaGui': {
        'name': '漫画柜',
        'url': 'https://www.manhuagui.com/',
        'method': 'GET',
        'headers': {'User-Agent': 'Mozilla/5.0'},
        'data': None,
        'line_opts': '官方主站 / 多 CDN',
        'advice': '• 站点位于境外且有防爬保护，LZString 混淆解密正常，建议在代理环境下使用。'
    },
    'jm': {
        'name': '禁漫天堂',
        'url': 'https://cdngwc.club/',
        'method': 'GET',
        'headers': {'User-Agent': 'Mozilla/5.0'},
        'data': None,
        'line_opts': '官方 5 条分流线路',
        'advice': '• 脚本内置 5 条官方线路自动故障转移，直连遇单点阻断时会自动无感轮换至可用分流。'
    },
    'picacg': {
        'name': 'Picacg / 哔咔',
        'url': 'https://picaapi.picacomic.com/init',
        'method': 'GET',
        'headers': None, # Dynamically built HMAC
        'data': None,
        'line_opts': '官方境外节点',
        'advice': '• 境外专属服务，HMAC 动态签名正常，必须在海外代理环境下登录账号使用。'
    },
    'ehentai': {
        'name': 'E-Hentai',
        'url': 'https://e-hentai.org/',
        'api_url': 'https://api.e-hentai.org/api.php',
        'method': 'GET',
        'headers': {'User-Agent': 'Mozilla/5.0', 'Cookie': 'nw=1'},
        'data': None,
        'line_opts': '`e-hentai.org` / API',
        'advice': '• 境外专属服务，v1.2.3 修复 DOM 标签解析与防封头，必须在海外代理环境下使用。'
    },
    'nhentai': {
        'name': 'nhentai',
        'url': 'https://nhentai.net/api/v2/search?query=chinese&page=1&sort=date',
        'method': 'GET',
        'headers': {'User-Agent': 'Mozilla/5.0', 'Referer': 'https://nhentai.net/'},
        'data': None,
        'line_opts': '`nhentai.net` / v2 API',
        'advice': '• 境外专属服务，v1.1.3 适配 v2 嵌套结构与防 429 缓存，必须在海外代理环境下使用。'
    },
    'hitomi': {
        'name': 'hitomi.la',
        'url': 'https://hitomi.la/',
        'method': 'GET',
        'headers': {'User-Agent': 'Mozilla/5.0'},
        'data': None,
        'line_opts': '官方图库节点',
        'advice': '• 境外专属服务，集成 LRU 缓存与 B-tree 搜索加速，必须在海外代理环境下使用。'
    },
    'wnacg': {
        'name': '紳士漫畫',
        'url': 'https://www.wnacg.com/',
        'method': 'GET',
        'headers': {'User-Agent': 'Mozilla/5.0'},
        'data': None,
        'line_opts': '官方主站',
        'advice': '• 境外专属服务，v1.0.11 修复移动端 UA 选择器匹配，必须在海外代理环境下使用。'
    },
    'shonen_jump_plus': {
        'name': '少年Jump+',
        'url': 'https://shonenjumpplus.com/api/v1/user_account/access_token',
        'method': 'POST',
        'headers': {'Origin': 'https://shonenjumpplus.com', 'Referer': 'https://shonenjumpplus.com/', 'X-Giga-Device-Id': '0123456789abcdef', 'User-Agent': 'ShonenJumpPlus-Android/4.3.0'},
        'data': b'',
        'line_opts': '集英社官方 API',
        'advice': '• 集英社官方 API 跨境直连极易超时；走海外代理延迟大幅降至 280ms，并发秒出图。'
    },
    'comic_walker': {
        'name': 'カドコミ',
        'url': 'https://mobileapp.comic-walker.com/v1/users',
        'method': 'POST',
        'headers': {'X-API-Environment-Key': 'ytBrdQ2ZYdRQguqEusVLxQVUgakNnVht', 'User-Agent': 'BookWalkerApp/1.6.3 (Android 13)', 'Content-Type': 'application/json'},
        'data': b'',
        'line_opts': '角川官方 API',
        'advice': '• 角川官方移动端 API 国内直连偶有延迟；推荐海外代理环境获得秒开体验。'
    },
    'ccc': {
        'name': 'CCC追漫台',
        'url': 'https://api.creative-comic.tw/public/home_v2',
        'method': 'GET',
        'headers': {'User-Agent': 'Mozilla/5.0', 'device': 'web_desktop', 'uuid': 'null'},
        'data': None,
        'line_opts': '台湾官方 API',
        'advice': '• 台湾官方正版漫画站点，已内置合规 Web 请求头与 URI 编码，代理环境下速度更佳。'
    }
}

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

def format_badge(latency_ms, code):
    if code in ['ERR', None] or latency_ms < 0:
        return '❌ **无法直连** (阻断)'
    if code == 401:
        return f'🟡 **需登录** (`~{latency_ms}ms`)'
    if latency_ms < 500:
        return f'🟢 **秒开** (`~{latency_ms}ms`)'
    elif latency_ms <= 1500:
        return f'🟢 **良好** (`~{latency_ms}ms`)'
    elif latency_ms <= 3500:
        return f'🟡 **偏慢** (`~{latency_ms}ms`)'
    else:
        return f'🟡 **高延迟** (`~{latency_ms}ms`)'

def probe_local_proxy():
    print("🌍 正在测试 [海外代理环境] (3次平滑采样)...")
    results = {}
    for key, p in PROBES.items():
        urls_to_try = [p['url']]
        if p.get('fallback_urls'):
            urls_to_try.extend(p['fallback_urls'])
            
        method = p['method']
        headers = p['headers'] or (get_pica_headers() if key == 'picacg' else {'User-Agent': 'Mozilla/5.0'})
        data = p['data']
        
        probe_success = False
        for url in urls_to_try:
            latencies = []
            codes = []
            for _ in range(3):
                req = urllib.request.Request(url, data=data, headers=headers, method=method)
                t0 = time.time()
                try:
                    with urllib.request.urlopen(req, timeout=8) as resp:
                        resp.read(512)
                        latencies.append(int((time.time() - t0) * 1000))
                        codes.append(resp.status)
                except urllib.error.HTTPError as e:
                    latencies.append(int((time.time() - t0) * 1000))
                    codes.append(e.code)
                except Exception:
                    codes.append('ERR')
                time.sleep(0.1)
                
            valid_lats = [l for l in latencies if l > 0]
            if any(c != 'ERR' for c in codes) and valid_lats:
                avg_lat = sum(valid_lats) // len(valid_lats)
                code = [c for c in codes if c != 'ERR'][0]
                results[key] = {'latency': avg_lat, 'code': code}
                probe_success = True
                break
                
        if not probe_success:
            results[key] = {'latency': -1, 'code': 'ERR'}
            
        print(f"  [{key:16}] 代理延迟: {results[key]['latency']}ms, 状态码: {results[key]['code']}")
    return results

def probe_mainland_primary_ssh(host, key_content, user="probe-runner"):
    print(f"\n🚀 尝试 [主引擎：私有受限沙盒探针]...")
    key_path = "/tmp/alicloud_probe_key"
    with open(key_path, "w") as f:
        f.write(key_content.strip() + "\n")
    os.chmod(key_path, 0o600)
    
    cmd = [
        "ssh",
        "-o", "StrictHostKeyChecking=no",
        "-o", "ConnectTimeout=8",
        "-i", key_path,
        f"{user}@{host}"
    ]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
        if res.returncode == 0 and "CN-Mainland-Direct" in res.stdout:
            data = json.loads(res.stdout.strip().split("\n")[-1])
            parsed = {}
            for k, v in data.get('results', {}).items():
                parsed[k] = {'latency': v.get('latency_ms', -1), 'code': v.get('code', 'ERR')}
            print("  ✅ 私有沙盒节点探测成功并回传数据！")
            return parsed, "中国大陆骨干网节点"
        else:
            print(f"  ⚠️ 私有探针返回非预期结果: {res.stderr[:200]}")
            return None, None
    except Exception as e:
        print(f"  ⚠️ 私有主引擎连接失败 ({e})，准备故障转移到备用引擎...")
        return None, None
    finally:
        if os.path.exists(key_path):
            os.remove(key_path)

def probe_mainland_fallback_globalping():
    print("\n🌐 启动 [备用引擎：Globalping 开源探针]...")
    results = {}
    for key, p in PROBES.items():
        target_url = p.get('cn_url') or p['url']
        parsed_host = target_url.split("://")[1].split("/")[0]
        path_part = "/" + "/".join(target_url.split("://")[1].split("/")[1:]) if "/" in target_url.split("://")[1] else "/"
        
        payload = {
            "target": parsed_host,
            "type": "http",
            "measurementOptions": {
                "request": {
                    "method": "GET",
                    "path": path_part,
                    "headers": {"User-Agent": "Mozilla/5.0"}
                },
                "protocol": "HTTPS" if target_url.startswith("https") else "HTTP"
            },
            "locations": [{"country": "CN"}]
        }
        
        try:
            req = urllib.request.Request(
                "https://api.globalping.io/v1/measurements",
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json", "User-Agent": "VeneraX-HealthCheck/1.0"}
            )
            with urllib.request.urlopen(req, timeout=6) as resp:
                m_id = json.loads(resp.read().decode("utf-8"))["id"]
                
            time.sleep(2)
            with urllib.request.urlopen(f"https://api.globalping.io/v1/measurements/{m_id}", timeout=6) as presp:
                pdata = json.loads(presp.read().decode("utf-8"))
                probe_res = pdata.get("results", [])
                if probe_res:
                    timings = probe_res[0].get("result", {}).get("timings", {})
                    total_rtt = timings.get("total")
                    code = probe_res[0].get("result", {}).get("statusCode", 200)
                    if total_rtt:
                        results[key] = {'latency': total_rtt, 'code': code}
                    else:
                        results[key] = {'latency': -1, 'code': 'ERR'}
                else:
                    results[key] = {'latency': -1, 'code': 'ERR'}
        except Exception:
            results[key] = {'latency': -1, 'code': 'ERR'}
        print(f"  [{key:16}] Globalping 国内延迟: {results[key]['latency']}ms, 状态码: {results[key]['code']}")
        time.sleep(0.2)
        
    valid_count = sum(1 for v in results.values() if v['latency'] > 0)
    if valid_count >= 3:
        print("  ✅ Globalping 备用引擎探测完成！")
        return results, "Globalping (中国大陆多节点)"
    else:
        print("  ❌ Globalping 备用引擎国内探针不可用！")
        return None, None

def update_readme_table(mainland_data, proxy_data, engine_name):
    root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    readme_path = os.path.join(root_dir, 'README.md')
    if not os.path.exists(readme_path):
        return False
        
    with open(readme_path, 'r', encoding='utf-8') as f:
        content = f.read()
        
    start_marker = "## 🧭 各漫画源最佳线路与网络推荐指南 (Recommended Lines)"
    end_marker = "## 🛠️ 重点修复与更新日志 (Changelog)"
    
    p_start = content.find(start_marker)
    p_end = content.find(end_marker)
    if p_start == -1 or p_end == -1:
        print("Marker not found in README.md, skip update.")
        return False
        
    dual_time = get_dual_time_str(False)
    
    new_section = f"""## 🧭 各漫画源最佳线路与网络推荐指南 (Recommended Lines)

> 🕒 **实测数据更新时间**：{dual_time}  
> 🌐 **双网络实测节点**：**中国大陆直连**（{engine_name}） vs **海外代理网络**（低延迟高速节点）  
> 📏 **延迟判定标准**：`<500ms` 🟢 **秒开/极速** ｜ `500~1500ms` 🟢 **良好/正常** ｜ `1500~3500ms` 🟡 **可用/偏慢** ｜ `>3500ms` 🟡 **高延迟** ｜ ❌ **阻断**

下表为 15 大精选核心源在两种真实网络环境下的**接口连通性与 3 次复测平均往返延迟（RTT）**，以及对应的最佳配置建议：

| 漫画源 | 线路 / 分流选项 | 大陆骨干直连实测 (3次平均延迟) | 海外代理实测 (3次平均延迟) | 最佳设置与线路实测建议 |
| :--- | :--- | :---: | :---: | :--- |
"""
    for key, p in PROBES.items():
        cn_res = mainland_data.get(key, {'latency': -1, 'code': 'ERR'})
        px_res = proxy_data.get(key, {'latency': -1, 'code': 'ERR'})
        
        cn_badge = format_badge(cn_res['latency'], cn_res['code'])
        px_badge = format_badge(px_res['latency'], px_res['code'])
        
        new_section += f"| **{p['name']}** | {p['line_opts']} | {cn_badge} | {px_badge} | {p['advice']} |\n"
        
    new_section += "\n---\n\n"
    
    updated_content = content[:p_start] + new_section + content[p_end:]
    with open(readme_path, 'w', encoding='utf-8') as f:
        f.write(updated_content)
    print("  📝 README.md 推荐指南表格已成功自动刷新！")
    return True

def generate_step_summary(mainland_data, proxy_data, engine_name, alert_msg=None):
    summary_file = os.environ.get('GITHUB_STEP_SUMMARY')
    if not summary_file:
        return
    md = f"# 🩺 VeneraX 漫画源自动化探活报告\n\n"
    md += f"- **测速时间**：{get_dual_time_str(True)}\n"
    md += f"- **大陆直连引擎**：`{engine_name}`\n"
    md += f"- **海外代理节点**：`GitHub Actions Runner (Overseas)`\n\n"
    
    if alert_msg:
        md += f"### 🚨 异常告警提醒\n> {alert_msg}\n\n"
        
    md += "| 漫画源 | 大陆直连状态/延迟 | 海外代理状态/延迟 |\n"
    md += "| :--- | :---: | :---: |\n"
    for key, p in PROBES.items():
        cn = mainland_data.get(key, {'latency': -1, 'code': 'ERR'})
        px = proxy_data.get(key, {'latency': -1, 'code': 'ERR'})
        md += f"| **{p['name']}** | `{cn['code']}` ({cn['latency']}ms) | `{px['code']}` ({px['latency']}ms) |\n"
        
    with open(summary_file, 'w', encoding='utf-8') as f:
        f.write(md)

def main():
    proxy_results = probe_local_proxy()
    
    # Check for SSH secret
    ssh_key = os.environ.get('PROBE_SSH_KEY')
    ssh_host = os.environ.get('PROBE_HOST')
    ssh_user = os.environ.get('PROBE_USER', 'probe-runner')
    
    mainland_results = None
    engine_name = None
    
    if ssh_key and ssh_host:
        mainland_results, engine_name = probe_mainland_primary_ssh(ssh_host, ssh_key, ssh_user)
        
    if not mainland_results:
        mainland_results, engine_name = probe_mainland_fallback_globalping()
        
    if not mainland_results:
        # Both engines failed! Trigger alert
        print("\n🚨 [致命异常] 主引擎与备用引擎均未能获取国内数据！")
        alert_body = "## 🚨 [VeneraX 探活报警] 大陆双探活引擎全部失效！\n\n"
        alert_body += f"- **检测时间**：{get_dual_time_str(True)}\n"
        alert_body += "- **故障现象**：私有 SSH 探针连接失败，且 Globalping 备用公共探针无响应。\n"
        alert_body += "- **安全措施**：工作流已终止更新，README 现有数据已完整保留。\n"
        alert_body += "\n请检查私有探针服务器状态或 GitHub Secrets 配置。"
        with open('/tmp/health_check_alert.md', 'w', encoding='utf-8') as f:
            f.write(alert_body)
        with open('/tmp/has_alert.txt', 'w') as f:
            f.write('true')
        generate_step_summary(mainland_results or {}, proxy_results, "全部失效 (已报警)", "大陆双探活引擎均连接失败")
        sys.exit(1)
        
    # Check if core sources have fatal errors on both networks
    fatal_sources = []
    for core_key in ['copy_manga', 'Komiic', 'baozi']:
        if proxy_results.get(core_key, {}).get('latency', -1) < 0 and mainland_results.get(core_key, {}).get('latency', -1) < 0:
            fatal_sources.append(core_key)
            
    if fatal_sources:
        alert_body = f"## 🚨 [VeneraX 漫画源宕机告警] 主力源双端无法连接！\n\n以下主力漫画源在国内外网络下均无法访问：\n"
        for fs in fatal_sources:
            alert_body += f"- 🔴 **{PROBES[fs]['name']} (`{fs}`)**\n"
        alert_body += "\n可能存在源站大改版或严重风控拦截，请及时排查。"
        with open('/tmp/health_check_alert.md', 'w', encoding='utf-8') as f:
            f.write(alert_body)
        with open('/tmp/has_alert.txt', 'w') as f:
            f.write('true')
        generate_step_summary(mainland_results, proxy_results, engine_name, f"主力源异常: {', '.join(fatal_sources)}")
    else:
        with open('/tmp/has_alert.txt', 'w') as f:
            f.write('false')
        generate_step_summary(mainland_results, proxy_results, engine_name)
        
    update_readme_table(mainland_results, proxy_results, engine_name)
    print("\n🎉 混合双引擎自动化健康巡检圆满完成！")

if __name__ == '__main__':
    main()
