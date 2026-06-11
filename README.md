# Private Video Vault

一个可部署到 GitHub Pages 的 PWA 壳，用于后续连接只存密文的内网视频仓库。

## 本地预览

```bash
python3 -m http.server 4173
```

打开 `http://localhost:4173`。

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
      "source": "/objects/random/master.m3u8"
    }
  ]
}
```

不要把密钥、明文视频信息或真实片名提交到 GitHub 仓库。
