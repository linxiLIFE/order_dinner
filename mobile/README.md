# 安卓端与固定打印设备

安卓端使用 Capacitor 加载同一套点单网页，默认连接线上地址；`scripts/package-android.sh` 会生成 `android/` 工程并构建使用本机 debug keystore 的测试签名 APK。正式分发前必须改用餐厅自己的签名密钥签名，并在 Android 8 及以上真实设备验收。

固定设备的打印流程已经由服务端实现：安卓打印服务通过 `/api/print-jobs/claim` 串行领取任务，向 XP-N160II 发送 ESC/POS 数据，再使用 `/api/print-jobs/:id/ack` 回执 `SENT`、`FAILED` 或 `NEEDS_CHECK`。同一任务包含设备编号、批次、份数和完整打印快照，不能用“重复领取”代替回执。

XP-N160II 可能使用经典蓝牙串口协议，不能仅凭网页构建通过判定打印可用。真实接入时应确认：配对方式、RFCOMM 通道、中文码表、80 毫米纸宽、缺纸/断链回执和重启后的未完成任务；协议未确认前，服务端仍可在网页中查看并重试打印任务。
