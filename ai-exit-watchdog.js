/*
* AI 出口看门狗（Quantumult X · cron 脚本）
* 版本：v1.0（2026-11-14）
*
* 每 2 小时确认一次：AI 流量当前的出口 IP 是否还是钉死节点的那个。
* 出口 IP 被悄悄换掉（机场换落地、订阅更新、分组误触）是 AI 账号
* 被风控的常见原因，所以：
* - 出口 != 基准 IP：通知一次（同一新 IP 不重复轰炸）
* - 出口回到基准 IP：若之前报过漂移，再通知一次“已恢复”
* - 查不到出口（如圈X没开）：不吭声，避免误报
*
* 任务行（配置文件 [task_local]）：每 2 小时一次（cron 第 15 分钟）
*/

var EXPECTED = "154.9.30.165";
var STORE_KEY = "ai_watchdog_v1";
var TIMEOUT = 15000;
var UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

function loadStore() {
try { return JSON.parse($persistentStore.read(STORE_KEY) || "{}");} catch (e) { return {};}
}
function saveStore(o) {
try { $persistentStore.write(JSON.stringify(o), STORE_KEY);} catch (e) {}
}

Promise.race([
$task.fetch({ url: "https://chatgpt.com/cdn-cgi/trace", method: "GET", headers: { "User-Agent": UA}}),
new Promise(function (_, rej) { setTimeout(function () { rej(new Error("timeout"));}, TIMEOUT);})
]).then(function (resp) {
var ip = "";
var m = (resp.body || "").match(/ip=([^\n]+)/);
if (m) ip = m[1].trim();
if (!ip) { $done(); return;}
var store = loadStore();
console.log("AI出口看门狗：当前出口 " + ip + "（基准 " + EXPECTED + "）");
if (ip === EXPECTED) {
if (store.notifiedFor) {
$notify("AI出口看门狗", "✅ 已恢复", "AI 出口已回到钉死节点：" + EXPECTED);
store.notifiedFor = "";
saveStore(store);
}
} else if (store.notifiedFor !== ip) {
$notify("⚠️ AI出口漂移", "当前出口不是钉死节点",
"当前 AI 出口：" + ip + "\n应为（[美国] 原生₄）：" + EXPECTED +
"\n若不是你手动切换的节点，尽快检查「AI服务」分组；若已换主节点，告诉 Muse 更新基准。");
store.notifiedFor = ip;
saveStore(store);
}
$done();
}).catch(function (e) {
$done();
});
