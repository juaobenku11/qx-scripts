/*
* 节点健康巡检（Quantumult X · cron 脚本）
* 版本：v2.0（2026-11-14，自动跟随版，取代 v1.0 的固定名单）
*
* 每天 8:00 和 20:00（晚高峰）各巡检一次。巡检对象不再写死：
* 先读「AI服务」策略组当前选中的节点，你选哪个它就巡哪个——
* 测它的出口 IP / 延迟 + Claude API 是否通。只在状态变化时通知：
* - 节点挂了（连不上，或 Claude 不通）
* - 节点恢复
* - 出口 IP 变了（机场换落地要第一时间知道）
* - 你换了节点：发一份新节点的基线报告，之后盯新节点
* 全部正常时不发通知（结果只记日志）。首次运行会发一份基线报告。
*
* 实现：策略组状态用 $configuration 的 get_policy_state 读（与
* ai-node-check v2.2、看门狗 v2.0 同一机制）；探测时用 opts.policy
* 指定该节点。若策略状态接口不可用，退化为按分流规则测当前 AI
* 出口（节点名沿用上次读到的），功能不受影响。
*
* 任务行（配置文件 [task_local]）：每天 8:00 与 20:00 各一次，
* tag=节点健康巡检（远程地址即本脚本的 GitHub raw 地址）
*/

var GROUP = "AI服务";
var STORE_KEY = "node_patrol_v2";
var TIMEOUT = 12000;
var UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

function get(url, policy) {
var req = { url: url, method: "GET", headers: { "User-Agent": UA}};
if (policy) req.opts = { policy: policy};
return Promise.race([
$task.fetch(req),
new Promise(function (_, rej) { setTimeout(function () { rej(new Error("timeout"));}, TIMEOUT);})
]).then(function (resp) {
return { ok: true, status: resp.statusCode, body: resp.body || ""};
}).catch(function (e) {
return { ok: false, status: 0, body: ""};
});
}

function checkNode(name, policy) {
var t0 = Date.now();
return get("https://chatgpt.com/cdn-cgi/trace", policy).then(function (tr) {
var ms = Date.now() - t0;
var ip = "";
if (tr.ok && tr.body) {
var m = tr.body.match(/ip=([^\n]+)/);
if (m) ip = m[1].trim();
}
if (!ip) return { name: name, ok: false, why: "连不上", ip: "", ms: 0};
return get("https://api.anthropic.com/v1/models", policy).then(function (r) {
var claudeOk = r.ok && r.status === 401;
return {
name: name, ok: claudeOk, ip: ip, ms: ms,
why: claudeOk? "": "Claude异常(" + (r.status || "无响应") + ")"
};
});
});
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

function loadStore() {
try { return JSON.parse($persistentStore.read(STORE_KEY) || "{}");} catch (e) { return {};}
}
function saveStore(o) {
try { $persistentStore.write(JSON.stringify(o), STORE_KEY);} catch (e) {}
}

resolveSelection().then(function (sel) {
var store = loadStore();
var label = sel? sel.leaf: (store.node || "AI服务（当前出口）");
var policy = sel? sel.leaf: null;
return checkNode(label, policy).then(function (r) {
var first = !store.booted;
var switched = !!sel && !!store.node && sel.leaf !== store.node;
var line = (r.ok? "✅ ": "🔴 ") + r.name + (r.ok? (" · " + r.ip + " · " + r.ms + "ms"): (" · " + r.why));
console.log(line);
if (first) {
store.booted = true;
$notify("节点健康巡检 · 已开启（自动跟随）", "每天 8:00 / 20:00 巡检你选中的 AI 节点，只在异常时提醒", line);
} else if (switched) {
$notify("节点健康巡检 · 已跟随切换", "「AI服务」选中了新节点，巡检目标已更新", line);
} else {
var events = [];
var prev = store.state;
if (prev) {
if (prev.ok && !r.ok) events.push("🔴 " + r.name + " 挂了：" + r.why);
else if (!prev.ok && r.ok) events.push("🟢 " + r.name + " 已恢复（" + r.ip + "）");
else if (r.ok && prev.ip && r.ip && prev.ip !== r.ip) events.push("🟡 " + r.name + " 出口IP变了：" + prev.ip + " → " + r.ip);
}
if (events.length) $notify("节点健康巡检", events.join("；"), line);
}
store.node = r.name;
store.state = { ok: r.ok, ip: r.ip};
saveStore(store);
$done();
});
}).catch(function (e) {
console.log("patrol error: " + e);
$done();
});
