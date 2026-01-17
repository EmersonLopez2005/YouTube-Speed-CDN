// ==UserScript==
// @name         YouTube 极速网速 + 真实CDN定位
// @name:en      YouTube Speed & CDN Sniffer
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  在"详细统计信息"面板中显示实时网速(MB/s)，并使用 DoH + GeoIP 技术精准识别视频 CDN 节点的物理位置（如：香港、新加坡、美国等）。
// @description:en Shows real-time speed (MB/s) and accurate CDN location (DoH + GeoIP) in the "Stats for nerds" panel.
// @author       BlingCc & Refined by Gemini
// @match        *://www.youtube.com/*
// @match        *://m.youtube.com/*
// @match        *://music.youtube.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @connect      dns.google
// @connect      cloudflare-dns.com
// @connect      ipwho.is
// @connect      ipapi.co
// @run-at       document-start
// @license      MIT
// ==/UserScript==

(function() {
    'use strict';

    // --- 配置 ---
    const CONFIG = {
        cdnCacheTtl: 600 * 1000,       // CDN缓存时间 (10分钟)
        geoCacheTtl: 24 * 3600 * 1000, // GeoIP缓存时间 (24小时)
        colorSpeed: '#4fc3f7',         // 亮蓝色 (MB/s)
        colorCdn: '#a5d6a7'            // 浅绿色 (地区)
    };

    // --- 状态变量 ---
    let state = { cdnText: '', cdnCode: '', lastHost: '', isResolving: false };
    const CONVERTED_VALUE_ID = 'yt-speed-converter-mbps-display';

    // --- 地区代码映射 ---
    const COUNTRY_MAP = {
        "HK": "香港", "CN": "中国", "TW": "台湾", "MO": "澳门",
        "JP": "日本", "KR": "韩国", "SG": "新加坡", "MY": "马来西亚",
        "TH": "泰国", "VN": "越南", "ID": "印尼", "PH": "菲律宾",
        "IN": "印度", "US": "美国", "CA": "加拿大", "GB": "英国",
        "DE": "德国", "FR": "法国", "NL": "荷兰", "AU": "澳洲",
        "RU": "俄罗斯", "BR": "巴西"
    };

    // --- 核心网络工具 (DoH + GeoIP) ---
    function resolveHostToIp(host) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: "GET",
                url: `https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A`,
                onload: (res) => {
                    try {
                        const data = JSON.parse(res.responseText);
                        if (data.Answer) {
                            const a = data.Answer.find(x => x.type === 1);
                            if (a && a.data) { resolve(a.data); return; }
                        }
                    } catch(e) {}
                    resolve(null);
                },
                onerror: () => resolve(null)
            });
        });
    }

    function resolveIpToGeo(ip) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: "GET",
                url: `https://ipwho.is/${ip}`,
                onload: (res) => {
                    try {
                        const data = JSON.parse(res.responseText);
                        if (data.success) {
                            resolve({ code: data.country_code, name: data.country });
                            return;
                        }
                    } catch(e) {}
                    resolve(null);
                },
                onerror: () => resolve(null)
            });
        });
    }

    // --- 数据处理逻辑 ---
    async function processCdnHost(host) {
        if (!host || !host.includes('googlevideo.com')) return;
        if (host === state.lastHost && state.cdnText) return;

        state.lastHost = host;
        state.isResolving = true;
        
        const cacheKeyHost = `cache_host_${host}`;
        const cached = GM_getValue(cacheKeyHost);
        
        if (cached && (Date.now() - cached.ts < CONFIG.geoCacheTtl)) {
            setCdnState(cached.geo);
            return;
        }

        const ip = await resolveHostToIp(host);
        if (!ip) { state.isResolving = false; return; }

        const geo = await resolveIpToGeo(ip);
        if (geo) {
            GM_setValue(cacheKeyHost, { ts: Date.now(), geo: geo });
            setCdnState(geo);
        } else {
            state.isResolving = false;
        }
    }

    function setCdnState(geo) {
        state.isResolving = false;
        state.cdnCode = geo.code;
        state.cdnText = COUNTRY_MAP[geo.code] || geo.code || geo.name;
    }

    // --- 网络钩子 (Hook) ---
    function hookNetwork() {
        const origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url) {
            if (typeof url === 'string' && url.includes('googlevideo.com/videoplayback')) {
                try { const u = new URL(url); processCdnHost(u.hostname); } catch(e) {}
            }
            return origOpen.apply(this, arguments);
        };
        
        const origFetch = unsafeWindow.fetch;
        unsafeWindow.fetch = function(input, init) {
            let url;
            if (typeof input === 'string') url = input;
            else if (input && input.url) url = input.url;
            if (url && url.includes('googlevideo.com/videoplayback')) {
                try { const u = new URL(url); processCdnHost(u.hostname); } catch(e) {}
            }
            return origFetch.apply(this, arguments);
        };
    }

    // --- UI 显示逻辑 ---
    function convertKbpsToMBps(kbpsString) {
        const kbps = parseInt(kbpsString.replace(/[^0-9]/g, ''), 10);
        if (isNaN(kbps)) return null;
        return (kbps / 8 / 1024).toFixed(2);
    }

    function updatePanelDisplay(speedValueSpan) {
        if (!speedValueSpan) return;
        const originalText = speedValueSpan.textContent;
        if (!/\d/.test(originalText)) return;
        const mbpsValue = convertKbpsToMBps(originalText);
        if (mbpsValue === null) return;

        let displayEl = document.getElementById(CONVERTED_VALUE_ID);
        if (!displayEl) {
            displayEl = document.createElement('span');
            displayEl.id = CONVERTED_VALUE_ID;
            displayEl.style.marginLeft = '12px';
            displayEl.style.fontWeight = 'bold';
            displayEl.style.whiteSpace = 'nowrap';
            if (speedValueSpan.parentElement) {
                speedValueSpan.parentElement.appendChild(displayEl);
            }
        }

        displayEl.textContent = '';
        const speedSpan = document.createElement('span');
        speedSpan.textContent = `(${mbpsValue} MB/s)`;
        speedSpan.style.color = CONFIG.colorSpeed;
        displayEl.appendChild(speedSpan);

        if (state.cdnText || state.isResolving) {
            const cdnSpan = document.createElement('span');
            cdnSpan.style.marginLeft = '8px';
            cdnSpan.style.color = CONFIG.colorCdn;
            cdnSpan.textContent = state.isResolving && !state.cdnText ? '[定位中...]' : `[${state.cdnText || '未知'}]`;
            displayEl.appendChild(cdnSpan);
        }
    }

    function setupPanelObserver(panelNode) {
        const labelDivXpath = ".//div[contains(text(), 'Connection Speed') or contains(text(), '连接速度')]";
        const labelDiv = document.evaluate(labelDivXpath, panelNode, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        if (!labelDiv || !labelDiv.nextElementSibling) return;
        const speedValueSpan = labelDiv.nextElementSibling.querySelector('span:nth-child(2)') || labelDiv.nextElementSibling.querySelector('span');

        if (speedValueSpan) {
            updatePanelDisplay(speedValueSpan);
            const observer = new MutationObserver(() => updatePanelDisplay(speedValueSpan));
            observer.observe(speedValueSpan, { characterData: true, childList: true, subtree: true });
            panelNode.dataset.ytSpeedObserved = 'true';
        }
    }

    function setupMainObserver() {
        const targetNode = document.getElementById('movie_player') || document.body;
        if (!targetNode) { setTimeout(setupMainObserver, 500); return; }

        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.addedNodes.length) {
                    mutation.addedNodes.forEach(node => {
                        if (node.nodeType === 1) {
                            if (node.classList.contains('html5-video-info-panel')) setupPanelObserver(node);
                            else if (node.querySelector) {
                                const panel = node.querySelector('.html5-video-info-panel');
                                if (panel && !panel.dataset.ytSpeedObserved) setupPanelObserver(panel);
                            }
                        }
                    });
                }
            }
        });
        observer.observe(targetNode, { childList: true, subtree: true });
        const existingPanel = document.querySelector('.html5-video-info-panel');
        if (existingPanel) setupPanelObserver(existingPanel);
    }

    hookNetwork();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setupMainObserver);
    else setupMainObserver();
})();
