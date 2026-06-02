# Cloudflare Email & KV 邮件收件箱

这是一个基于 Cloudflare Workers 和 KV 存储构建的轻量级邮件收件箱。它支持通过 Web 界面输入邮箱地址并实时查看该地址收到的邮件内容。

## 功能特性

- **现代 Web 界面**: 提供简洁、响应式的深色模式 UI。
- **实时邮件接收**: 利用 Cloudflare Email Routing 捕获邮件。
- **持久化存储**: 使用 Cloudflare KV 存储邮件数据。
- **一键查询**: 输入邮箱地址即可快速检索所有已接收的邮件。

## 快速开始

### 1. 准备工作

确保你已经安装了 [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-setup/) 并已登录你的 Cloudflare 账号。

### 2. 创建 KV 空间

在项目根目录下运行以下命令：
登录cloudflare
```bash
npx wrangler login
```


```bash
npx wrangler kv namespace create EMAIL_KV
```

执行后，你会得到一个类似下面的输出：

```toml
[[kv_namespaces]]
binding = "EMAIL_KV"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

请将该 `id` 复制并替换到 `wrangler.toml` 文件中对应的位置。

### 3. 部署到 Cloudflare

运行部署命令：

```bash
npx wrangler deploy
```

### 4. 配置邮件路由 (Email Routing)

1. 登录 [Cloudflare 控制台](https://dash.cloudflare.com/)。
2. 选择你的域名，进入 **Email (电子邮件)** > **Email Routing (电子邮件路由)**。
3. 在 **Email Workers** 选项卡中，确保 `cloudflare-email-kv` 已启用。
4. 在 **Routing Rules (路由规则)** 选项卡中，点击 "Add custom address"：
   - **Custom address**: 输入你想使用的邮箱前缀（或使用通配符）。
   - **Action**: 选择 "Send to Worker"。
   - **Worker**: 选择 `cloudflare-email-kv`。

## 使用说明

1. 访问部署后的 Worker URL。
2. 在输入框中输入你配置的邮箱地址（例如 `test@yourdomain.com`）。
3. 使用你的其他邮箱向该地址发送一封测试邮件。
4. 返回页面点击 **“查看收件箱”**，即可看到邮件的主题、发件人和内容预览。

## 技术栈

- **Cloudflare Workers**: 后端逻辑与 API。
- **Cloudflare KV**: 高性能键值存储。
- **Vanilla JS & CSS**: 前端交互与样式（无外部依赖）。

## 许可证

MIT
