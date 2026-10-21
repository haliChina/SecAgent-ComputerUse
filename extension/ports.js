// 自动发现端口段：与插件侧 driver/extension-bridge.mjs 的 PREFERRED_PORTS
// 保持同值。桥优先监听这里，扩展无凭据时逐个扫描。
export const DISCOVERY_PORTS = [39700, 39701, 39702, 39703, 39704, 39705];
