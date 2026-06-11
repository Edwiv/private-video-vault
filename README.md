# Private Video Vault

一个可部署到 GitHub Pages 的 PWA 壳，用于后续连接只存密文的内网视频仓库。

## 本地预览

```bash
npm run dev
```

打开 `http://localhost:4173`。

## 生成并播放 demo vault

用本机上的一个视频生成加密 HLS 分片和加密片库索引：

```bash
VIDEO_VAULT_PASSPHRASE=demo-secret node tools/build-demo-vault.mjs "/path/to/video.mp4" demo-vault
```

启动只存密文的 vault 服务：

```bash
npm run vault:serve
```

另开一个终端启动 PWA：

```bash
npm run dev
```

打开 `http://localhost:4173`，输入：

```text
仓库地址: http://127.0.0.1:8787
索引文件: /library.enc.json
主密钥: demo-secret
```

`demo-vault/` 不会提交到 GitHub。生产环境里，GitHub Pages 上的 PWA 访问内网 vault 时需要 HTTPS，不能用普通 `http://`。

## 生成加密索引

在可信电脑上编辑一个明文索引，例如 `examples/library.example.json`，然后生成密文：

```bash
node tools/encrypt-library.mjs examples/library.example.json library.enc.json
```

生成的 `library.enc.json` 应该上传到内网 NAS，不要提交到公开仓库。

## 发布到 GitHub Pages

1. 在 GitHub 创建一个空仓库。
2. 把当前仓库推送到 GitHub：

```bash
git remote add origin git@github.com:YOUR_NAME/private-video-vault.git
git add .
git commit -m "Create GitHub Pages PWA"
git push -u origin main
```

3. 在仓库的 `Settings -> Pages` 中选择 `GitHub Actions`。
4. 等待 `Deploy GitHub Pages` workflow 完成。

## 加密索引格式

PWA 会尝试从内网仓库读取一个 AES-GCM 加密索引文件，例如 `/library.enc.json`：

```json
{
  "version": 1,
  "cipher": "AES-GCM",
  "kdf": {
    "name": "PBKDF2",
    "hash": "SHA-256",
    "iterations": 310000,
    "salt": "base64..."
  },
  "iv": "base64...",
  "data": "base64..."
}
```

解密后的 JSON：

```json
{
  "videos": [
    {
      "id": "random-id",
      "title": "Title",
      "duration": "01:30:00",
      "hls": {
        "method": "AES-128",
        "key": "base64-raw-16-byte-key",
        "iv": "0x...",
        "variants": [
          {
            "label": "720p",
            "bandwidth": 2800000,
            "resolution": "1280x720",
            "playlist": "#EXTM3U\n#EXT-X-VERSION:3\n..."
          }
        ]
      }
    }
  ]
}
```

不要把密钥、明文视频信息或真实片名提交到 GitHub 仓库。
