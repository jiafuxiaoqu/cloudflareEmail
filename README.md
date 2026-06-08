# Cloudflare Email & KV 邮件收件箱

基于 Cloudflare Workers + KV 的轻量级邮件收件箱。支持 Web 界面按邮箱地址搜索并查看收到的邮件内容。

![Interface Screenshot](https://pbs.twimg.com/media/HJ9NUwnaYAA0hen?format=jpg&name=medium)


## 功能特性

- **现代 Web 界面**: 深色主题、响应式 UI，无需任何前端框架
- **实时邮件接收**: 利用 Cloudflare Email Routing 捕获邮件
- **持久化存储**: 使用 Cloudflare KV 存储邮件数据
- **邮箱搜索 + 分页**: 按收件人过滤，支持翻页浏览

## 快速开始

### 1. 准备工作

确保已安装 [Node.js](https://nodejs.org/) 和 [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-setup/)。

### 2. 登录 Cloudflare

```bash
npx wrangler login
```

浏览器会自动打开 Cloudflare 授权页面，登录后即可继续。

### 3. 创建 KV 空间

```bash
npx wrangler kv namespace create EMAIL_KV
```

执行后会输出类似以下内容：

```toml
[[kv_namespaces]]
binding = "EMAIL_KV"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

将输出的 `id` 复制并替换到 `wrangler.toml` 文件中对应的位置。

### 4. 部署到 Cloudflare

```bash
npx wrangler deploy
```

### 5. 配置邮件路由 (Email Routing)

1. 登录 [Cloudflare 控制台](https://dash.cloudflare.com/)。
2. 选择你的域名，进入 **Email** > **Email Routing**。
3. 在 **Email Workers** 选项卡中，确保 `cloudflare-email-kv` 已启用。
4. 在 **Routing Rules** 选项卡中，点击 "Add custom address"：
   - **Custom address**: 输入你想使用的邮箱前缀（可使用通配符 `*`）。
   - **Action**: 选择 "Send to Worker"。
   - **Worker**: 选择 `cloudflare-email-kv`。

## 使用说明

1. 访问部署后的 Worker URL。
2. 页面会自动加载全部邮件。也可在输入框中输入收件人地址进行过滤搜索。
3. 用其他邮箱向已配置的地址发送测试邮件，返回页面刷新即可看到。

## 技术栈

- **Cloudflare Workers**: 后端逻辑与 API
- **Cloudflare KV**: 高性能键值存储
- **Vanilla JS & CSS**: 无外部依赖的前端实现

## 许可证

MIT
