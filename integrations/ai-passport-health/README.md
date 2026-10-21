# AI Passport 健康工卡

用 FoloToy AI Passport 的 ESP32-C3 和 240×320 屏幕展示 HealthRelay 的压力、睡眠、健身与活动。它通过家里 Wi-Fi 或 iPhone 热点读取云端快照，每 30 分钟更新，可以脱离电脑使用。

[完整数据流、部署、构建、烧录和操作说明](../../docs/ai-passport-health.md)

| 文件 | 用途 |
| --- | --- |
| `prepare_firmware.py` + `firmware.patch` | 从固定上游 commit 重建完整可构建固件源码，包含五页 LVGL、Wi-Fi、配网和息屏 |
| `tools/configure_wifi.py` | 从本机私有 JSON 经 USB 初始化 HTTPS 读取地址与独立设备凭据 |
| `tools/health_bridge.py` | 可选 USB 兼容桥接和合成演示；Wi-Fi 初始化后不承担持续同步 |
| `miaobi/badge-cache-reader.cjs` | 妙笔 HTTP FaaS 模板：鉴权后只读一条固定的私有 Base 缓存记录 |
| `miaobi/prepare_reader.py` | 从私有部署坐标文件生成可发布的 FaaS 源码，不把个人资源 ID 写入公开模板 |
| `../hae-webhook/badge.mjs` | 与现有评分同源的紧凑 v3 展示协议，不在工卡重新评分 |
| `../hae-webhook/badge-cache-publisher.mjs` | Cloudflare 主动更新专用私有工卡缓存，与原看板发布独立重试 |

固件固定基线：[`FoloToy/ai-passport@3d685a9`](https://github.com/FoloToy/ai-passport/tree/3d685a90bdb96dd8526d84edde1e63fec25b460e)，工具链为 ESP-IDF 5.5.3。补丁包含实际 C 源码和测试，不依赖私有云端版本、生产源码归档或本机绝对路径。原上游 MIT 声明保留在 [LICENSE.firmware](LICENSE.firmware)，准备后的源码也保留上游 `LICENSE`。

```sh
# 在 HealthRelay 仓库根目录执行；目标必须尚不存在
python3 integrations/ai-passport-health/prepare_firmware.py private-artifacts/badge-source

# 无硬件的 Python 工具检查
python3 -m unittest discover -s integrations/ai-passport-health/tests
python3 -m unittest discover -s integrations/ai-passport-health/miaobi -p 'test_*.py'
node --test integrations/ai-passport-health/miaobi/badge-cache-reader.test.mjs
```

`firmware.patch` 的 `main/health_*.c` 是应用实现；`components/bsp` 来自固定上游版本。屏幕用 C/LVGL 本地绘制，通过 SPI 输出，不下载 HTML、图片或浏览器页面。
