/*
* AI 出口看门狗（Quantumult X · cron 脚本）
* 版本：v2.0（2026-11-14，自动跟随版，取代 v1.0 的写死基准 IP）
*
* 每 2 小时先读「AI服务」策略组当前选中的节点——你选哪个它就盯哪个，
* 不用再手动改基准：
* - 首次运行：发一份基准报告（当前盯的节点 + 出口 IP），之后安静值守
* - 你换了节点（或组内的自动组换了最优节点）：通知一次“已跟随切换”，
*   基准自动换到新节点，不会误报漂移
* - 节点没换、但出口 IP 变了（机场在同一个节点名背后换了落地 IP）：
*   报警一次（同一新 IP 不重复轰炸）
* - 连续 2 次查不到出口 IP：通知一次“AI 出口无响应”；恢复后通知一次。
*   单次失败不吭声，避免圈X没开/临时断网时误报
*
* 实现：策略组状态用 $configuration 的 get_policy_state 读（与
* ai-node-check v2.2 同一机制）；出口 IP 用不带 policy 的 trace 请求
* 测，它按分流规则走，命中的就是「AI服务」当前出口。若策略状态接口
* 不可用，自动退化为“只记 IP、变了就报”，功能不受影响。
*
* 任务行（配置文件 [task_local]）：每 2 小时的第 15 分钟运行一次，
* tag=AI出口看门狗（远程地址即本脚本的 GitHub raw 地址）
*/

var GROUP = "AI服务";
var STORE_KEY = "ai_watchdog_v2";
var TIMEOUT = 15000;
var FAIL_ALERT_AT = 2;
var UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

function loadStore() {
try { return JSON.parse($persistentStore.read(STORE_KEY) || "{}");} catch (e) { return {};}
}
function saveStore(o) {
try { $persistentStore.write(JSON.stringify(o), STORE_KEY);} catch (e) {}
}

function fetchIp() {
return Promise.race([
$task.fetch({ url: "https://chatgpt.com/cdn-cgi/trace", method: "GET", headers: { "User-Agent": UA}}),
new Promise(function (_, rej) { setTimeout(function () { rej(new Error("timeout"));}, TIMEOUT);})
]).then(function (resp) {
var m = (resp.body || "").match(/ip=([^\n]+)/);
return m? m[1].trim(): "";
}).catch(function () { return "";});
}

function resolveSelection() {
try {
if (typeof $configuration === "undefined" || !$configuration.sendMessage) return Promise.resolve(null);
var ipc = $configuration.sendMessage({ action: "get_policy_state", content: GROUP});
var guard = new Promise(function (res) { setTimeout(function () { res(null);}, 3000);});
return Promise.race([ipc, guard]).then(function (r) {
try {
if (r && r.ret && r.ret[GROUP]) {
var arr = r.ret[GROUP];
if (Array.isArray(arr) && arr.length) return { leaf: arr[arr.length - 1], chain: GROUP + " ➟ " + arr.join(" ➟ ")};
}
} catch (e) {}
return null;
}).catch(function () { return null;});
} catch (e) {
return Promise.resolve(null);
}
}

Promise.all([resolveSelection(), fetchIp()]).then(function (vals) {
var sel = vals[0];
var ip = vals[1];
var store = loadStore();

if (!ip) {
store.fails = (store.fails || 0) + 1;
console.log("AI出口看门狗：本次未查到出口 IP（连续失败 " + store.fails + " 次）");
if (store.fails >= FAIL_ALERT_AT && !store.downNotified) {
$notify("⚠️ AI出口无响应", "连续 " + store.fails + " 次查不到 AI 出口 IP",
"「AI服务」当前节点：" + (sel? sel.leaf: (store.node || "未知")) +
"\n可能节点已失效或圈X未运行，请检查。若是你手动关了圈X，忽略本条。");
store.downNotified = true;
}
saveStore(store);
$done();
return;
}

if (store.downNotified) {
$notify("AI出口看门狗", "✅ AI 出口已恢复响应", "当前出口 IP：" + ip);
store.downNotified = false;
}
store.fails = 0;

var node = sel? sel.leaf: (store.node || "");
console.log("AI出口看门狗：节点 " + (node || "未知") + "，出口 " + ip);

if (!store.booted) {
store.booted = true;
store.node = node;
store.ip = ip;
$notify("AI出口看门狗 · 已开启（自动跟随）", "你选哪个节点它就盯哪个，每 2 小时检查",
"当前节点：" + (node || "未知") +
"\n当前出口 IP：" + ip +
"\n之后只在你换节点、或同一节点的出口 IP 被换掉时才通知。");
} else if (sel && store.node && sel.leaf !== store.node) {
$notify("AI出口看门狗 · 已跟随切换", "「AI服务」选中的节点变了",
"原节点：" + store.node +
"\n新节点：" + sel.leaf +
"\n新出口 IP：" + ip +
"\n若是你手动换的，忽略即可，看门狗已改盯新节点。");
store.node = sel.leaf;
store.ip = ip;
} else if (store.ip && ip !== store.ip) {
if (node) {
$notify("⚠️ AI出口 IP 漂移", "节点没换，出口 IP 变了",
"当前节点：" + node +
"\n原出口 IP：" + store.ip +
"\n现出口 IP：" + ip +
"\n节点名没变但落地变了——多半是机场在后台换了落地 IP。");
} else {
$notify("⚠️ AI出口 IP 变化", "当前 AI 出口 IP 与上次不同",
"原出口 IP：" + store.ip + "\n现出口 IP：" + ip);
}
store.ip = ip;
if (sel) store.node = sel.leaf;
}
saveStore(store);
$done();
}).catch(function (e) {
console.log("watchdog error: " + e);
$done();
});
