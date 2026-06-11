# Private Video Vault

一个可部署到 GitHub Pages 的 PWA 壳。PWA 只负责在浏览器端解锁片库索引，真实视频文件和索引文件应放在只存密文的内网 vault 服务中。

## 本地预览

```bash
npm run dev
```

打开 `http://localhost:4173`。

## 生成 vault

用一个视频生成加密 HLS 分片和加密片库索引。默认是 `--mode copy`，只复制原始音视频码流，不重新编码、不压缩画质：

```bash
VIDEO_VAULT_PASSPHRASE='<strong-passphrase>' node tools/build-demo-vault.mjs "/path/to/video.mp4" vault --mode copy --title "Video Title"
```

可以给视频写入展示目录，PWA 解锁后会按文件树显示：

```bash
VIDEO_VAULT_PASSPHRASE='<strong-passphrase>' node tools/build-demo-vault.mjs "/path/to/video.mp4" vault --mode copy --folder "Movies/2026" --title "Video Title"
```

也可以直接指定完整展示路径：

```bash
VIDEO_VAULT_PASSPHRASE='<strong-passphrase>' node tools/build-demo-vault.mjs "/path/to/video.mp4" vault --mode copy --path "Movies/2026/Video Title"
```

生成完成后，`vault/` 目录中只应保留密文分片和 `library.enc.json`。不要把明文源视频、口令、密钥、真实片名或 `vault/` 提交到 GitHub。

## 提供内网 vault

GitHub Pages 通过 HTTPS 提供 PWA，因此内网 vault 地址也必须是 HTTPS。可以让内网网关负责 TLS 终止，再把请求转发到 NAS 上的 HTTP 后端：

```bash
sudo env "PATH=$PATH" node tools/serve-vault.mjs vault 80 ::
```

PWA 中填写：

```text
仓库地址: https://your-internal-vault.example
索引文件: /library.enc.json
主密钥: <strong-passphrase>
```

如果浏览器或 iPhone 不信任内网 HTTPS 证书，需要先安装并信任对应的根证书，或者改用受系统信任的证书链。

## 记住此设备

PWA 第一次用主密钥解锁成功后，会把已解锁片库快照保存在当前浏览器本地。快照使用浏览器本地生成的 AES-GCM key 加密保存，主密钥不会写入本地缓存。

再次打开 PWA 时，如果本地快照仍然存在，会自动恢复片库并配置播放器。点击清除配置会删除仓库地址、片库快照和本地缓存 key。

## 发布到 GitHub Pages

仓库的 GitHub Actions workflow 只发布 PWA 静态文件，不发布工具脚本、README 或本地生成的 vault 内容。

在仓库的 `Settings -> Pages` 中选择 `GitHub Actions`，然后等待 `Deploy GitHub Pages` workflow 完成。

## 安全边界

- GitHub Pages 只托管公开 PWA 壳，不包含视频、索引、口令或密钥。
- 内网 vault 服务只托管密文文件；拿到文件但没有主口令时，不能解锁片库索引。
- 选择记住此设备后，当前浏览器会保存已解锁片库快照；这会把片名、目录和播放所需 key 留在这台设备的浏览器存储里。
- NAS 管理员仍然可以删除、替换或拒绝服务，但不能仅凭 vault 文件解密视频内容。
- 公开仓库不要保存真实环境地址、真实片名、真实路径、导入口令或任何明文素材信息。
