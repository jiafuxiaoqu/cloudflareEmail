/// <reference types="@cloudflare/workers-types" />
import iconv = require('iconv-lite');
import PostalMime from 'postal-mime';

export interface Env {
    EMAIL_KV: KVNamespace;
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(request.url);

        // Serve Frontend
        if (url.pathname === "/" || url.pathname === "/index.html") {
            return new Response(FRONTEND_HTML, {
                headers: { "Content-Type": "text/html;charset=UTF-8" },
            });
        }

        // API: Save Email Registration
        if (url.pathname === "/api/save" && request.method === "POST") {
            try {
                const { email } = await request.json() as { email: string };
                if (!email) return new Response("Email required", { status: 400 });

                // Save registration
                await env.EMAIL_KV.put(`reg:${email}`, JSON.stringify({ registeredAt: Date.now() }));

                return new Response(JSON.stringify({ success: true }), {
                    headers: { "Content-Type": "application/json" },
                });
            } catch (e) {
                return new Response("Invalid JSON", { status: 400 });
            }
        }

        // API: Get Messages
        if (url.pathname === "/api/messages" && request.method === "GET") {
            const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
            const pageSize = Math.min(50, Math.max(1, parseInt(url.searchParams.get("pageSize") || "10", 10) || 10));
            const allKeys: any[] = [];
            let cursor: string | undefined;

            do {
                const list = await env.EMAIL_KV.list({ prefix: "msg:", cursor });
                allKeys.push(...list.keys);
                cursor = list.list_complete ? undefined : list.cursor;
            } while (cursor);

            allKeys.sort((a, b) => getMessageTimestampFromKey(b.name) - getMessageTimestampFromKey(a.name));

            const total = allKeys.length;
            const totalPages = Math.max(1, Math.ceil(total / pageSize));
            const start = (page - 1) * pageSize;
            const pageKeys = allKeys.slice(start, start + pageSize);
            const messages = [];

            for (const key of pageKeys) {
                const content = await env.EMAIL_KV.get(key.name);
                if (content) {
                    messages.push(normalizeStoredMessage(JSON.parse(content)));
                }
            }

            messages.sort((a, b) => b.timestamp - a.timestamp);

            return new Response(JSON.stringify({
                messages,
                page,
                pageSize,
                total,
                totalPages,
                hasPrev: page > 1,
                hasNext: page < totalPages
            }), {
                headers: { "Content-Type": "application/json" },
            });
        }

        return new Response("Not Found", { status: 404 });
    },

    async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
        const raw = await new Response(message.raw).arrayBuffer();
        const rawBytes = new Uint8Array(raw);
        const rawSource = bytesToBinaryString(rawBytes);
        const parser = new PostalMime();
        const parsed = await parser.parse(rawBytes);

        const rawSubject = getHeader(rawSource, "Subject");
        const rawFrom = getHeader(rawSource, "From");
        const rawText = decodeMimePart(rawSource, "text/plain");
        const rawHtml = decodeMimePart(rawSource, "text/html");
        const text = rawText || decodeTextValue(parsed.text || "");
        const parsedHtml = rawHtml || decodeTextValue(parsed.html || "");
        const html = parsedHtml || (looksLikeHtml(text) ? text : "");
        const subject = decodeMimeHeader(rawSubject || parsed.subject || "") || "(No Subject)";
        const fromName = decodeMimeHeader(parsed.from?.name || getAddressName(rawFrom) || "");

        const emailData = {
            from: parsed.from?.address || message.from,
            fromName,
            to: (parsed.to && parsed.to.length > 0) ? parsed.to.map(t => t.address).join(', ') : message.to,
            subject,
            timestamp: Date.now(),
            text,
            body: text,
            html,
            raw: rawSource,
            snippet: createSnippet(html && looksLikeHtml(text) ? htmlToPlainText(html) : text)
        };

        await env.EMAIL_KV.put(`msg:${message.to}:${Date.now()}`, JSON.stringify(emailData));
    },
};

function getMessageTimestampFromKey(key: string): number {
    const timestamp = Number(key.slice(key.lastIndexOf(":") + 1));
    return Number.isFinite(timestamp) ? timestamp : 0;
}

function normalizeStoredMessage(message: any): any {
    const rawSource = typeof message.raw === "string"
        ? message.raw
        : looksLikeRawEmail(message.text) ? message.text
            : looksLikeRawEmail(message.body) ? message.body : "";
    const rawSubject = rawSource ? getHeader(rawSource, "Subject") : "";
    const rawFrom = rawSource ? getHeader(rawSource, "From") : "";
    const rawText = rawSource ? decodeMimePart(rawSource, "text/plain") || decodeFirstMatchingPart(rawSource, "text/plain") : "";
    const rawHtml = rawSource ? decodeMimePart(rawSource, "text/html") || decodeFirstMatchingPart(rawSource, "text/html") : "";
    const subject = decodeMimeHeader(rawSubject || message.subject || "") || message.subject || "(No Subject)";
    const storedText = decodeTextValue(message.text || message.body || "");
    const text = rawSource ? rawText || storedText : storedText;
    const storedHtml = decodeTextValue(message.html || "");
    const html = rawHtml || storedHtml || (looksLikeHtml(text) ? text : "");
    const snippetSource = html && looksLikeHtml(text) ? htmlToPlainText(html) : text;
    const { raw: _raw, ...safeMessage } = message;

    return {
        ...safeMessage,
        fromName: decodeMimeHeader(message.fromName || getAddressName(rawFrom) || ""),
        subject,
        text,
        body: text,
        html,
        snippet: createSnippet(snippetSource)
    };
}

function looksLikeHtml(value: unknown): value is string {
    if (typeof value !== "string") return false;
    const sample = value.trim();
    if (!sample) return false;

    return /<!doctype\s+html|<html[\s>]|<body[\s>]/i.test(sample)
        || /<\/?(?:div|p|br|table|thead|tbody|tr|td|th|a|span|strong|em|ul|ol|li|img|h[1-6]|style)\b[^>]*>/i.test(sample);
}

function htmlToPlainText(value: string): string {
    return value
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<br\b[^>]*>/gi, "\n")
        .replace(/<\/(?:p|div|tr|li|h[1-6])>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, "\"")
        .replace(/&#39;/g, "'");
}

function createSnippet(value: string): string {
    const snippet = value.slice(0, 200).replace(/\s+/g, " ").trim();
    return snippet + (value.length > 200 ? "..." : "");
}

function looksLikeRawEmail(value: unknown): value is string {
    return typeof value === "string"
        && /^Received:/i.test(value.trimStart())
        && /\r?\nSubject:/i.test(value)
        && /\r?\nContent-Type:/i.test(value);
}

function bytesToBinaryString(bytes: Uint8Array): string {
    let result = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
        result += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return result;
}

function getHeader(raw: string, name: string): string {
    const headerBlock = raw.split(/\r?\n\r?\n/, 1)[0] || "";
    const lines = headerBlock.split(/\r?\n/);
    const values: string[] = [];
    let collecting = false;

    for (const line of lines) {
        if (new RegExp(`^${escapeRegExp(name)}:`, "i").test(line)) {
            collecting = true;
            values.push(line.slice(line.indexOf(":") + 1).trim());
            continue;
        }

        if (collecting && /^[ \t]/.test(line)) {
            values.push(line.trim());
            continue;
        }

        if (collecting) break;
    }

    return values.join(" ");
}

function decodeMimeHeader(value: string): string {
    if (!value) return "";

    return value.replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_match, charset, encoding, encoded) => {
        const normalized = normalizeCharset(charset);
        const bytes = encoding.toLowerCase() === "b"
            ? base64ToBytes(encoded)
            : decodeQuotedPrintableToBytes(encoded.replace(/_/g, " "));

        return decodeBytes(bytes, normalized);
    }).trim();
}

function decodeMimePart(raw: string, mimeType: string): string {
    const boundaryMatch = raw.match(/Content-Type:\s*multipart\/[^;\r\n]+;[\s\S]*?boundary=(?:"([^"]+)"|([^;\s\r\n]+))/i);
    if (!boundaryMatch) return "";

    const boundary = boundaryMatch[1] || boundaryMatch[2];
    const parts = raw.split(`--${boundary}`).slice(1);

    for (const part of parts) {
        if (part.startsWith("--")) break;

        const cleaned = part.replace(/^\r?\n/, "");
        const separator = cleaned.search(/\r?\n\r?\n/);
        if (separator === -1) continue;

        const headers = cleaned.slice(0, separator);
        const separatorMatch = cleaned.match(/\r?\n\r?\n/);
        if (!separatorMatch || separatorMatch.index === undefined) continue;

        const body = cleaned.slice(separatorMatch.index + separatorMatch[0].length).replace(/\r?\n$/, "");
        const contentType = headers.match(/Content-Type:\s*([^;\r\n]+)/i)?.[1]?.toLowerCase();
        if (contentType !== mimeType.toLowerCase()) continue;

        const charsetMatch = headers.match(/charset=(?:"([^"]+)"|([^;\s\r\n]+))/i);
        const charset = normalizeCharset(charsetMatch?.[1] || charsetMatch?.[2] || "utf-8");
        const transferEncoding = headers.match(/Content-Transfer-Encoding:\s*([^\s\r\n]+)/i)?.[1]?.toLowerCase() || "7bit";

        if (transferEncoding === "base64") {
            return decodeBytes(base64ToBytes(body), charset);
        }

        if (transferEncoding === "quoted-printable") {
            return decodeBytes(decodeQuotedPrintableToBytes(body), charset);
        }

        return decodeBytes(binaryStringToBytes(body), charset);
    }

    return "";
}

function decodeFirstMatchingPart(raw: string, mimeType: string): string {
    const partPattern = /(?:^|\r?\n)-{2}[^\r\n]+\r?\n([\s\S]*?Content-Type:\s*[^;\r\n]+[\s\S]*?)(?=\r?\n-{2}[^\r\n]+(?:\r?\n|--))/gi;
    let match: RegExpExecArray | null;

    while ((match = partPattern.exec(raw)) !== null) {
        const part = match[1].replace(/^\r?\n/, "");
        const separatorMatch = part.match(/\r?\n\r?\n/);
        if (!separatorMatch || separatorMatch.index === undefined) continue;

        const headers = part.slice(0, separatorMatch.index);
        const contentType = headers.match(/Content-Type:\s*([^;\r\n]+)/i)?.[1]?.toLowerCase();
        if (contentType !== mimeType.toLowerCase()) continue;

        const body = part.slice(separatorMatch.index + separatorMatch[0].length).replace(/\r?\n$/, "");
        const charsetMatch = headers.match(/charset=(?:"([^"]+)"|([^;\s\r\n]+))/i);
        const charset = normalizeCharset(charsetMatch?.[1] || charsetMatch?.[2] || "utf-8");
        const transferEncoding = headers.match(/Content-Transfer-Encoding:\s*([^\s\r\n]+)/i)?.[1]?.toLowerCase() || "7bit";

        if (transferEncoding === "base64") {
            return decodeBytes(base64ToBytes(body), charset);
        }

        if (transferEncoding === "quoted-printable") {
            return decodeBytes(decodeQuotedPrintableToBytes(body), charset);
        }

        return decodeBytes(binaryStringToBytes(body), charset);
    }

    return "";
}

function decodeTextValue(value: string): string {
    return decodeMimeHeader(value);
}

function decodeBytes(bytes: Uint8Array, charset: string): string {
    if (!bytes.length) return "";
    return iconv.decode(bytes, charset as any);
}

function base64ToBytes(value: string): Uint8Array {
    const binary = atob(value.replace(/\s+/g, ""));
    return binaryStringToBytes(binary);
}

function binaryStringToBytes(value: string): Uint8Array {
    const bytes = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i++) {
        bytes[i] = value.charCodeAt(i) & 0xff;
    }
    return bytes;
}

function decodeQuotedPrintableToBytes(value: string): Uint8Array {
    const bytes: number[] = [];
    const input = value.replace(/=\r?\n/g, "");

    for (let i = 0; i < input.length; i++) {
        if (input[i] === "=" && /^[0-9a-f]{2}$/i.test(input.slice(i + 1, i + 3))) {
            bytes.push(parseInt(input.slice(i + 1, i + 3), 16));
            i += 2;
        } else {
            bytes.push(input.charCodeAt(i) & 0xff);
        }
    }

    return new Uint8Array(bytes);
}

function normalizeCharset(charset: string): string {
    return charset.trim().toLowerCase().replace(/^gb2312$/, "gb18030").replace(/^gbk$/, "gb18030");
}

function getAddressName(header: string): string {
    return (header.match(/^\s*"([^"]+)"/)?.[1] || header.match(/^\s*([^<]+)/)?.[1] || "").trim();
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const FRONTEND_HTML = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Cloudflare Inbox</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600&display=swap" rel="stylesheet">
    <style>
        :root {
            --primary: #f63;
            --primary-light: #ff7d4d;
            --bg: #0f172a;
            --card-bg: #1e293b;
            --text: #f8fafc;
            --text-dim: #94a3b8;
            --border: #334155;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: 'Inter', system-ui, -apple-system, sans-serif;
            background-color: var(--bg);
            color: var(--text);
            line-height: 1.5;
            padding: 2rem 1rem;
        }
        .container {
            max-width: 800px;
            margin: 0 auto;
        }
        header {
            text-align: center;
            margin-bottom: 3rem;
        }
        h1 {
            font-size: 2.5rem;
            font-weight: 700;
            margin-bottom: 0.5rem;
            background: linear-gradient(135deg, #f63 0%, #ff8c00 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        .subtitle { color: var(--text-dim); font-size: 1.1rem; }
        
        .search-box {
            background: var(--card-bg);
            padding: 1.5rem;
            border-radius: 1rem;
            box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.3);
            display: flex;
            gap: 1rem;
            margin-bottom: 2rem;
            border: 1px solid var(--border);
        }
        input {
            flex: 1;
            background: #0f172a;
            border: 1px solid var(--border);
            padding: 0.8rem 1.2rem;
            border-radius: 0.5rem;
            color: white;
            font-size: 1rem;
            outline: none;
            transition: border-color 0.2s;
        }
        input:focus { border-color: var(--primary); }
        button {
            background: var(--primary);
            color: white;
            border: none;
            padding: 0.8rem 1.5rem;
            border-radius: 0.5rem;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
        }
        button:hover { background: var(--primary-light); transform: translateY(-1px); }
        
        .email-list { display: flex; flex-direction: column; gap: 1rem; }
        .email-card {
            background: var(--card-bg);
            border-radius: 1rem;
            border: 1px solid var(--border);
            overflow: hidden;
            transition: transform 0.2s;
        }
        .email-header {
            padding: 1.2rem;
            cursor: pointer;
            display: grid;
            grid-template-columns: 1fr auto;
            gap: 0.5rem;
        }
        .email-header:hover { background: rgba(255,255,255,0.03); }
        .subject { font-weight: 600; font-size: 1.1rem; margin-bottom: 0.3rem; }
        .from { font-size: 0.9rem; color: var(--text-dim); }
        .time { font-size: 0.8rem; color: var(--text-dim); white-space: nowrap; }
        
        .email-content {
            padding: 0 1.2rem 1.2rem;
            border-top: 1px solid var(--border);
            display: none;
            background: #0f172a;
        }
        .email-content.active { display: block; }
        .body-text {
            white-space: pre-wrap;
            font-size: 0.95rem;
            color: #cbd5e1;
            padding: 1.5rem 0;
            word-break: break-word;
            line-height: 1.8;
        }
        .body-html {
            background: white;
            color: black;
            padding: 1rem;
            border-radius: 0.5rem;
            margin-top: 1rem;
            overflow-x: auto;
        }

        /* 详情视图样式 */
        .email-detail-header {
            padding: 1.5rem 0;
            border-bottom: 1px solid var(--border);
            margin-bottom: 1rem;
        }
        .detail-row {
            display: flex;
            margin-bottom: 0.6rem;
            font-size: 0.9rem;
        }
        .detail-label {
            color: var(--text-dim);
            width: 80px;
            flex-shrink: 0;
        }
        .detail-value {
            color: var(--text);
            word-break: break-all;
        }
        .detail-subject {
            font-size: 1.25rem;
            font-weight: 700;
            color: var(--primary);
            margin-bottom: 1rem;
        }

        .empty-state {
            text-align: center;
            padding: 4rem 2rem;
            color: var(--text-dim);
            background: var(--card-bg);
            border-radius: 1rem;
            border: 1px dashed var(--border);
        }
        .badge {
            background: rgba(246, 102, 48, 0.1);
            color: var(--primary);
            padding: 0.2rem 0.6rem;
            border-radius: 99px;
            font-size: 0.75rem;
            font-weight: 600;
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>Cloudflare Inbox</h1>
            <p class="subtitle">极简、安全的邮件接收服务</p>
        </header>

        <div class="search-box">
            <input type="email" id="emailInput" placeholder="输入您的临时邮箱地址..." spellcheck="false">
            <button onclick="checkInbox()">刷新列表</button>
        </div>

        <div id="emailList" class="email-list">
            <div class="empty-state">输入邮箱地址并点击刷新以查看邮件</div>
        </div>
    </div>

    <script>
        async function checkInbox() {
            const email = document.getElementById('emailInput').value.trim();
            if (!email) {
                alert('请输入邮箱地址');
                return;
            }

            const listDiv = document.getElementById('emailList');
            listDiv.innerHTML = '<div class="empty-state">正在同步邮件数据...</div>';

            try {
                // 保存最后使用的邮箱到本地存储
                localStorage.setItem('last_email', email);
                
                await fetch('/api/save', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email })
                });

                const response = await fetch('/api/messages?email=' + encodeURIComponent(email));
                const messages = await response.json();

                if (messages.length === 0) {
                    listDiv.innerHTML = '<div class="empty-state">暂无邮件。请确保已正确配置路由并发送测试邮件。</div>';
                    return;
                }

                listDiv.innerHTML = '';
                messages.forEach((msg, index) => {
                    const card = document.createElement('div');
                    card.className = 'email-card';
                    
                    const timeStr = new Date(msg.timestamp).toLocaleString('zh-CN', {
                        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
                    });

                    card.innerHTML = \`
                        <div class="email-header" onclick="toggleEmail(\${index})">
                            <div class="info">
                                <div class="subject">\${escapeHtml(msg.subject)}</div>
                                <div class="from">\${escapeHtml(msg.fromName || '')} &lt;\${escapeHtml(msg.from)}&gt;</div>
                            </div>
                            <div class="time">\${timeStr}</div>
                        </div>
                        <div id="content-\${index}" class="email-content">
                            <div class="email-detail-header">
                                <div class="detail-subject">\${escapeHtml(msg.subject)}</div>
                                <div class="detail-row">
                                    <div class="detail-label">发件人：</div>
                                    <div class="detail-value">\${escapeHtml(msg.fromName || '')} &lt;\${escapeHtml(msg.from)}&gt;</div>
                                </div>
                                <div class="detail-row">
                                    <div class="detail-label">收件人：</div>
                                    <div class="detail-value">\${escapeHtml(msg.to || '')}</div>
                                </div>
                                <div class="detail-row">
                                    <div class="detail-label">时间：</div>
                                    <div class="detail-value">\${timeStr}</div>
                                </div>
                            </div>
                            \${renderMessageBody(msg)}
                        </div>
                    \`;
                    listDiv.appendChild(card);
                });
            } catch (e) {
                listDiv.innerHTML = '<div class="empty-state" style="color: #f87171;">查询失败，请确认域名解析与 Worker 状态。</div>';
            }
        }

        function toggleEmail(index) {
            const content = document.getElementById('content-' + index);
            const isActive = content.classList.contains('active');
            
            // 关闭其他
            document.querySelectorAll('.email-content').forEach(el => el.classList.remove('active'));
            
            if (!isActive) {
                content.classList.add('active');
            }
        }

        function escapeHtml(str) {
            if (!str) return '';
            return str.replace(/[&<>"']/g, function(m) {
                return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
            });
        }

        function renderMessageBody(msg) {
            const text = msg.text || msg.body || '';
            const html = msg.html || (looksLikeHtml(text) ? text : '');

            if (html && looksLikeRichHtml(html)) {
                return \`<div class="badge">可视化内容</div><iframe srcdoc="\${escapeAttr(html)}" style="width:100%; border:none; min-height:500px; background:white; margin-top:15px; border-radius:8px;"></iframe>\`;
            }

            return \`<div class="badge">纯文本内容</div><div class="body-text">\${escapeHtml(html ? htmlToPlainText(html) : text)}</div>\`;
        }

        function looksLikeHtml(str) {
            if (!str) return false;
            const sample = String(str).trim();
            return /<!doctype\\s+html|<html[\\s>]|<body[\\s>]/i.test(sample)
                || /<\\/?(?:div|p|br|table|thead|tbody|tr|td|th|a|span|strong|em|ul|ol|li|img|h[1-6]|style)\\b[^>]*>/i.test(sample);
        }

        function looksLikeRichHtml(str) {
            if (!str) return false;
            const sample = String(str).trim();
            return /<!doctype\\s+html|<html[\\s>]|<body[\\s>]|<head[\\s>]|<style[\\s>]|<table[\\s>]|<img[\\s>]/i.test(sample)
                || /<(?:a|div|span|p|td|th)\\b[^>]*(?:href|style|class|id|src|width|height)=/i.test(sample);
        }

        function htmlToPlainText(str) {
            return String(str)
                .replace(/<script\\b[^>]*>[\\s\\S]*?<\\/script>/gi, ' ')
                .replace(/<style\\b[^>]*>[\\s\\S]*?<\\/style>/gi, ' ')
                .replace(/<br\\b[^>]*>/gi, '\\n')
                .replace(/<\\/(?:p|div|tr|li|h[1-6])>/gi, '\\n')
                .replace(/<[^>]+>/g, ' ')
                .replace(/&nbsp;/gi, ' ')
                .replace(/&amp;/gi, '&')
                .replace(/&lt;/gi, '<')
                .replace(/&gt;/gi, '>')
                .replace(/&quot;/gi, '"')
                .replace(/&#39;/g, "'")
                .replace(/[ \\t]+/g, ' ')
                .replace(/\\n\\s+/g, '\\n')
                .trim();
        }

        function escapeAttr(str) {
            if (!str) return '';
            return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
        }

        // 页面加加载时恢复邮箱
        window.onload = () => {
            const last = localStorage.getItem('last_email');
            if (last) {
                document.getElementById('emailInput').value = last;
                checkInbox();
            }
        };

        let currentPage = 1;
        let totalPages = 1;
        const pageSize = 10;

        async function loadMessages(page = currentPage) {
            const listDiv = document.getElementById('emailList');
            listDiv.innerHTML = '<div class="empty-state">正在加载邮件...</div>';

            try {
                const response = await fetch('/api/messages?page=' + page + '&pageSize=' + pageSize);
                const data = await response.json();
                const messages = data.messages || [];
                currentPage = data.page || page;
                totalPages = data.totalPages || 1;
                updatePager(data);

                if (messages.length === 0) {
                    listDiv.innerHTML = '<div class="empty-state">暂无邮件</div>';
                    return;
                }

                listDiv.innerHTML = '';
                messages.forEach((msg, index) => {
                    const card = document.createElement('div');
                    card.className = 'email-card';

                    const timeStr = new Date(msg.timestamp).toLocaleString('zh-CN', {
                        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
                    });

                    card.innerHTML = \`
                        <div class="email-header" onclick="toggleEmail(\${index})">
                            <div class="info">
                                <div class="subject">\${escapeHtml(msg.subject || '')}</div>
                                <div class="from">\${escapeHtml(msg.fromName || '')} &lt;\${escapeHtml(msg.from || '')}&gt;</div>
                            </div>
                            <div class="time">\${timeStr}</div>
                        </div>
                        <div id="content-\${index}" class="email-content">
                            <div class="email-detail-header">
                                <div class="detail-subject">\${escapeHtml(msg.subject || '')}</div>
                                <div class="detail-row">
                                    <div class="detail-label">发件人：</div>
                                    <div class="detail-value">\${escapeHtml(msg.fromName || '')} &lt;\${escapeHtml(msg.from || '')}&gt;</div>
                                </div>
                                <div class="detail-row">
                                    <div class="detail-label">收件人：</div>
                                    <div class="detail-value">\${escapeHtml(msg.to || '')}</div>
                                </div>
                                <div class="detail-row">
                                    <div class="detail-label">时间：</div>
                                    <div class="detail-value">\${timeStr}</div>
                                </div>
                            </div>
                            \${renderMessageBody(msg)}
                        </div>
                    \`;
                    listDiv.appendChild(card);
                });
            } catch (e) {
                listDiv.innerHTML = '<div class="empty-state" style="color: #f87171;">查询失败，请稍后重试</div>';
            }
        }

        function setupPager() {
            const box = document.querySelector('.search-box');
            if (!box) return;
            box.innerHTML = '<button onclick="loadMessages(1)">刷新</button><div style="display:flex;align-items:center;gap:.75rem;color:#94a3b8;"><button id="prevBtn" onclick="changePage(-1)">上一页</button><span id="pageInfo">Page 1</span><button id="nextBtn" onclick="changePage(1)">下一页</button></div>';
            box.style.alignItems = 'center';
            box.style.justifyContent = 'space-between';
        }

        function updatePager(data) {
            const info = document.getElementById('pageInfo');
            const prev = document.getElementById('prevBtn');
            const next = document.getElementById('nextBtn');
            if (info) info.textContent = 'Page ' + currentPage + ' / ' + totalPages + ', total ' + (data.total || 0);
            if (prev) prev.disabled = !data.hasPrev;
            if (next) next.disabled = !data.hasNext;
        }

        function changePage(delta) {
            const nextPage = currentPage + delta;
            if (nextPage < 1 || nextPage > totalPages) return;
            loadMessages(nextPage);
        }

        window.onload = () => {
            setupPager();
            loadMessages(1);
        };
    </script>
</body>
</html>
`;
