/**
 *
 * 过滤无法访问 Gemini 的节点 (适配 Sub-Store Node.js 版)
 * * 通过 HTTP META 访问 https://gemini.google.com/ 获取内容，
 * * 检查响应内容是否包含特定字符串 ("45631641,null,true")。
 * * 移除无法访问或访问不符合预期的节点。
 * * 基于 https://github.com/clash-verge-rev/clash-verge-rev/blob/c894a15d13d5bcce518f8412cc393b56272a9afa/src-tauri/src/cmd/media_unlock_checker.rs#L241 的逻辑
 *
 * 需要先安装和配置好 http-meta: https://github.com/xream/http-meta
 *
 * HTTP META 参数 (从 $arguments 获取):
 * - [http_meta_protocol] 协议 默认: http
 * - [http_meta_host] 服务地址 默认: 127.0.0.1
 * - [http_meta_port] 端口号 默认: 9876
 * - [http_meta_authorization] Authorization 默认无
 * - [http_meta_start_delay] 初始启动延时(单位: 毫秒) 默认: 3000
 * - [http_meta_proxy_timeout] 每个节点分配的核心超时(单位: 毫秒). 默认: 10000
 *
 * 其它参数 (从 $arguments 获取):
 * - [retries] Gemini 检测重试次数 默认 1
 * - [retry_delay] 重试延时(单位: 毫秒) 默认 1000
 * - [concurrency] 检测并发数 默认 10
 * - [timeout] Gemini 检测请求超时(单位: 毫秒) 默认 5000
 * - [remove_incompatible] 移除当前客户端不兼容的协议节点. 默认不移除.
 * - [cache] 使用缓存. 默认不使用缓存 (缓存 Gemini 检测结果)
 * - [disable_failed_cache/ignore_failed_error] 禁用失败缓存. 即不缓存失败的检测结果, 默认 false
 */

async function operator(proxies = [], targetPlatform, context) {
  const $ = $substore;

  // --- 检查 $substore.http 是否存在 ---
  if (typeof $.http === 'undefined') {
      console.error("错误：$.http 对象未定义！脚本无法执行网络请求。");
      throw new Error("$.http 对象未定义！");
  }
  console.log("调试信息：$.http 对象已找到。");

  // --- 参数处理 ---
  const cacheEnabled = $arguments.cache ?? false;
  const cache = scriptResourceCache;
  const disableFailedCache = $arguments.disable_failed_cache || $arguments.ignore_failed_error || false;
  const remove_incompatible = $arguments.remove_incompatible ?? false;

  // HTTP META 相关参数
  const http_meta_host = $arguments.http_meta_host ?? '127.0.0.1';
  const http_meta_port = $arguments.http_meta_port ?? 9876;
  const http_meta_protocol = $arguments.http_meta_protocol ?? 'http';
  const http_meta_authorization = $arguments.http_meta_authorization ?? '';
  const http_meta_api = `${http_meta_protocol}://${http_meta_host}:${http_meta_port}`;
  const http_meta_start_delay = parseFloat($arguments.http_meta_start_delay ?? 3000);
  const http_meta_proxy_timeout = parseFloat($arguments.http_meta_proxy_timeout ?? 10000);

  // Gemini 检测相关参数
  const checkMethod = 'get';
  const checkUrl = 'https://gemini.google.com/'; // 固定检测 Gemini 的 URL
  const checkString = '45631641,null,true'; // 固定检测的特征字符串
  const concurrency = parseInt($arguments.concurrency || 10);
  const checkTimeout = parseFloat($arguments.timeout || 5000);
  const checkRetries = parseFloat($arguments.retries ?? 1);
  const checkRetryDelay = parseFloat($arguments.retry_delay ?? 1000);

  // --- 内部代理格式转换 ---
  const internalProxies = [];
  proxies.forEach((proxy, index) => {
    try {
      const node = ProxyUtils.produce([{ ...proxy }], 'ClashMeta', 'internal')?.[0];
      if (node) {
        for (const key in proxy) {
          if (/^_/i.test(key)) {
            node[key] = proxy[key];
          }
        }
        internalProxies.push({ ...node, _original_index: index });
      } else {
        if (remove_incompatible || $arguments.incompatible) {
             proxies[index]._incompatible = true;
        }
        $.warn(`节点 ${proxy.name} (${proxy.type}) 无法转换为内部格式，可能不被 HTTP META 支持。`);
      }
    } catch (e) {
      $.error(`处理节点 ${proxy.name} 时出错: ${e.message}`);
       if (remove_incompatible || $arguments.incompatible) {
           proxies[index]._incompatible = true;
       }
    }
  });

  $.info(`准备通过 HTTP META 检测 ${internalProxies.length} 个兼容节点 (共 ${proxies.length} 个) 的 Gemini 访问情况`);
  if (!internalProxies.length) {
      $.info('没有兼容的节点可供检测，直接返回原始节点列表。');
      if (remove_incompatible) {
          return proxies.filter(p => !p._incompatible);
      }
      return proxies;
  }

  // --- 启动 HTTP META ---
  const http_meta_total_timeout = http_meta_start_delay + internalProxies.length * http_meta_proxy_timeout;
  let http_meta_pid;
  let http_meta_ports = [];

  try {
    $.info(`正在启动 HTTP META 实例...`);
    // ... (HTTP META 启动逻辑，与上个脚本相同) ...
     const res = await http({
      retries: 0,
      method: 'post',
      url: `${http_meta_api}/start`,
      headers: {
        'Content-type': 'application/json',
        'Authorization': http_meta_authorization,
      },
      body: JSON.stringify({
        proxies: internalProxies,
        timeout: http_meta_total_timeout,
      }),
      timeout: 15000
    });
    let body = res.body;
    try { body = JSON.parse(body); } catch (e) { throw new Error(`HTTP META 启动响应解析失败: ${res.body}`); }
    if (!body || !body.pid || !body.ports || body.ports.length !== internalProxies.length) { throw new Error(`HTTP META 启动失败，响应无效: ${JSON.stringify(body)}`); }
    http_meta_pid = body.pid;
    http_meta_ports = body.ports;
    $.info(`\n======== HTTP META 启动成功 ====\n[端口范围] ${http_meta_ports[0]} - ${http_meta_ports[http_meta_ports.length - 1]}\n[PID] ${http_meta_pid}\n[核心超时] ${Math.round(http_meta_total_timeout / 600) / 100} 分钟\n========`);
    $.info(`等待 ${http_meta_start_delay / 1000} 秒让核心稳定...`);
    await $.wait(http_meta_start_delay);
  } catch (e) {
      $.error(`启动 HTTP META 失败: ${e.message}`);
      $.error("脚本将不会进行 Gemini 检测。");
       if (remove_incompatible) { return proxies.filter(p => !p._incompatible); }
      return proxies;
  }

  // --- 并发检测 Gemini 访问情况 ---
  const checkResults = new Array(internalProxies.length); // 存储检测结果 { index: originalIndex, accessible: boolean }
  await executeAsyncTasks(
    internalProxies.map((proxy, i) => async () => {
      const result = await checkGeminiAccess(proxy, i); // 调用新的检测函数
      checkResults[i] = result;
    }),
    { concurrency }
  );

  // --- 关闭 HTTP META ---
  try {
    $.info(`正在关闭 HTTP META 实例 (PID: ${http_meta_pid})...`);
    // ... (HTTP META 关闭逻辑，与上个脚本相同) ...
     await http({
          method: 'post',
          url: `${http_meta_api}/stop`,
          headers: { 'Content-type': 'application/json', 'Authorization': http_meta_authorization },
          body: JSON.stringify({ pid: [http_meta_pid] }),
          timeout: 10000
      });
     $.info(`======== HTTP META 已关闭 (PID: ${http_meta_pid}) ========`);
  } catch (e) {
      $.error(`关闭 HTTP META (PID: ${http_meta_pid}) 时出错: ${e.message}。`);
  }

  // --- 处理结果并过滤 ---
  const finalProxies = [];
  const processedResults = {}; // { originalIndex: boolean }
  checkResults.forEach(result => {
      if (result) { // 过滤掉可能的 null/undefined (虽然不应该出现)
        processedResults[result.index] = result.accessible;
      }
  });

  for (let i = 0; i < proxies.length; i++) {
      const proxy = proxies[i];

      // 1. 处理不兼容节点 (如果设置了 remove_incompatible)
      if (remove_incompatible && proxy._incompatible === true) {
          $.info(`移除不兼容节点: ${proxy.name}`);
          continue;
      }

      // 2. 获取检测结果
      const isAccessible = processedResults[i]; // 获取布尔值结果

      // 3. 根据检测结果进行过滤
      if (isAccessible === true) {
          // 保留可以访问 Gemini 的节点
          const finalProxy = { ...proxy };
          // 可以选择性移除 _incompatible 标记 (如果没设置保留的话)
          if (!$arguments.incompatible) {
             delete finalProxy._incompatible;
          }
          finalProxies.push(finalProxy);
          $.info(`[保留] 节点 ${proxy.name} 可以访问 Gemini`);
      } else {
          // isAccessible 为 false 或 undefined (检测失败/未检测)
          $.info(`[移除] 节点 ${proxy.name} 无法正常访问 Gemini (accessible: ${isAccessible})`);
      }
  }

  $.info(`Gemini 访问过滤完成，剩余 ${finalProxies.length} 个节点。`);
  return finalProxies;

  // --- Helper 函数 ---

  /**
   * 检测单个节点访问 Gemini 的情况
   * @param {object} internalProxy - HTTP META 内部格式的代理对象，包含 _original_index
   * @param {number} internalIndex - 在 internalProxies 数组中的索引
   * @returns {Promise<{index: number, accessible: boolean}>} - 返回包含原始索引和是否可访问的布尔值
   */
  async function checkGeminiAccess(internalProxy, internalIndex) {
    const originalIndex = internalProxy._original_index;
    const proxyName = proxies[originalIndex].name;
    const cacheId = cacheEnabled ? getCacheId(internalProxy) : undefined; // 使用新的 Cache ID

    try {
        // 检查缓存
        if (cacheEnabled) {
            const cached = cache.get(cacheId);
            if (cached && typeof cached.accessible === 'boolean') { // 检查缓存有效性
                if (cached.accessible) {
                     $.info(`[${proxyName}] 使用缓存: 可访问 Gemini`);
                     return { index: originalIndex, accessible: true };
                } else if (!disableFailedCache) { // 失败缓存且允许使用
                     $.info(`[${proxyName}] 使用缓存: 不可访问 Gemini`);
                     return { index: originalIndex, accessible: false };
                } else {
                     $.info(`[${proxyName}] 存在失败缓存，但已禁用`);
                }
            }
        }

        // $.info(`[${proxyName}] 开始检测 Gemini 访问...`);
        const proxyUrl = `http://${http_meta_host}:${http_meta_ports[internalIndex]}`;
        const res = await http({ // 使用封装的 http 请求
            proxy: proxyUrl,
            method: checkMethod,
            url: checkUrl,
            headers: { // 模拟浏览器 UA
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                'Accept-Language': 'en-US,en;q=0.9',
                'Sec-Ch-Ua': '"Chromium";v="110", "Not A(Brand";v="24", "Google Chrome";v="110"',
                'Sec-Ch-Ua-Mobile': '?0',
                'Sec-Ch-Ua-Platform': '"Windows"',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Upgrade-Insecure-Requests': '1',
            },
            timeout: checkTimeout,
            retries: checkRetries,
            retry_delay: checkRetryDelay,
            // Gemini 可能对纯 IP 访问或缺少某些头信息敏感，尽量模拟真实浏览器
            // 不设置 'Accept-Encoding': 'gzip, deflate' 可以避免处理解压缩，直接获取原始 body
        });

        const status = parseInt(res.status || res.statusCode || 0);
        const body = res.body || ''; // 获取响应体

        let isAccessible = false;
        // 检查状态码和响应体内容
        // Go 代码只检查了 body，这里也主要依据 body，但记录一下状态码
        if (status >= 200 && status < 400) { // 认为 2xx, 3xx 都是成功的请求，主要看内容
             if (typeof body === 'string' && body.includes(checkString)) {
                 isAccessible = true;
                 $.info(`[${proxyName}] 检测成功: 可访问 Gemini (Status: ${status}, Found String)`);
             } else {
                 $.warn(`[${proxyName}] 检测失败: 响应体未包含特征字符串 (Status: ${status})`);
             }
        } else {
            $.warn(`[${proxyName}] 检测失败: 请求状态码异常 (Status: ${status})`);
        }

        // 设置缓存
        if (cacheEnabled) {
            $.log(`[${proxyName}] 设置缓存: accessible = ${isAccessible}`);
            cache.set(cacheId, { accessible: isAccessible });
        }
        return { index: originalIndex, accessible: isAccessible };

    } catch (e) {
        $.error(`[${proxyName}] Gemini 检测异常: ${e.message ?? e}`);
        if (cacheEnabled) {
            $.log(`[${proxyName}] 设置失败缓存 (异常): accessible = false`);
            cache.set(cacheId, { accessible: false }); // 异常视为不可访问
        }
        return { index: originalIndex, accessible: false }; // 返回 false 表示失败
    }
  }

  /**
   * 生成缓存 ID (用于 Gemini 检测)
   * @param {object} internalProxy - HTTP META 内部格式代理对象
   * @returns {string}
   */
  function getCacheId(internalProxy) {
    const keyData = {};
    const omitKeys = ['_original_index', 'name', 'subName', 'id', 'collectionName'];
    const omitPattern = /^_/i;
    for (const key in internalProxy) {
        if (Object.prototype.hasOwnProperty.call(internalProxy, key)) {
            if (!omitKeys.includes(key) && !omitPattern.test(key)) {
                keyData[key] = internalProxy[key];
            }
        }
    }
    // 使用不同的前缀和固定的检测 URL 生成 ID
    return `gemini-check:${checkUrl}:${JSON.stringify(keyData)}`;
  }

  // --- 其他 Helper 函数 (http, executeAsyncTasks) ---
  // ... (与上个脚本中的 http 和 executeAsyncTasks 函数相同) ...
   async function http(opt = {}) { /* ... */ }
   function executeAsyncTasks(tasks, { concurrency = 1 } = {}) { /* ... */ }

   // 粘贴上一个脚本中的 http 和 executeAsyncTasks 函数到这里
   // 或者确保它们在你的 Sub-Store 环境中是可用的全局函数或库函数

   // --- 粘贴 http 函数 ---
    async function http(opt = {}) {
      const METHOD = (opt.method || 'get').toLowerCase();
      const TIMEOUT = parseFloat(opt.timeout || 5000);
      const RETRIES = parseFloat(opt.retries ?? 1);
      const RETRY_DELAY = parseFloat(opt.retry_delay ?? 1000);

      let count = 0;
      const fn = async () => {
        try {
          return await $.http[METHOD]({ ...opt, timeout: TIMEOUT });
        } catch (e) {
          if (count < RETRIES) {
            count++;
            const delay = RETRY_DELAY * count;
            $.warn(`请求 ${opt.url} 失败 (第 ${count} 次重试): ${e.message || e}, ${delay / 1000} 秒后重试...`);
            await $.wait(delay);
            return await fn();
          } else {
             $.error(`请求 ${opt.url} 达到最大重试次数 (${RETRIES})，最终失败: ${e.message || e}`);
            throw e;
          }
        }
      };
      return await fn();
    }

    // --- 粘贴 executeAsyncTasks 函数 ---
    function executeAsyncTasks(tasks, { concurrency = 1 } = {}) {
      return new Promise(async (resolve, reject) => {
        try {
          let running = 0;
          let index = 0;
          const results = [];

          function executeNextTask() {
            while (index < tasks.length && running < concurrency) {
              const taskIndex = index++;
              const currentTask = tasks[taskIndex];
              running++;

              currentTask()
                .then(data => {})
                .catch(error => { $.error(`任务 ${taskIndex + 1} 失败: ${error.message}`); })
                .finally(() => {
                  running--;
                  if (index === tasks.length && running === 0) { resolve(results); }
                  else { executeNextTask(); }
                });
            }
             if (index === tasks.length && running === 0) { resolve(results); }
          }
          executeNextTask();
        } catch (e) { reject(e); }
      });
    }

} // operator 函数结束
