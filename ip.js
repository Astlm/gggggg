/**
 *
 * 节点出口 IP 去重脚本 (适配 Sub-Store Node.js 版) - 无 Lodash 依赖版
 * * 通过 HTTP META 访问 http://checkip.amazonaws.com 获取每个节点的真实出口 IP，
 * 并移除出口 IP 重复的节点，每个 IP 只保留第一个遇到的节点。
 * * 已移除对 lodash 库的依赖。
 *
 * 需要先安装和配置好 http-meta: https://github.com/xream/http-meta
 *
 * HTTP META 参数 (从 $arguments 获取):
 * - [http_meta_protocol] 协议 默认: http
 * - [http_meta_host] 服务地址 默认: 127.0.0.1
 * - [http_meta_port] 端口号 默认: 9876
 * - [http_meta_authorization] Authorization 默认无
 * - [http_meta_start_delay] 初始启动延时(单位: 毫秒) 默认: 3000
 * - [http_meta_proxy_timeout] 每个节点分配的核心超时(单位: 毫秒). 防止脚本异常退出未关闭核心. 默认: 10000
 *
 * 其它参数 (从 $arguments 获取):
 * - [retries] IP 检测重试次数 默认 1
 * - [retry_delay] 重试延时(单位: 毫秒) 默认 1000
 * - [concurrency] 检测并发数 默认 10
 * - [timeout] IP 检测请求超时(单位: 毫秒) 默认 5000
 * - [remove_incompatible] 移除当前客户端不兼容的协议节点. 默认不移除.
 * - [cache] 使用缓存. 默认不使用缓存 (缓存 IP 检测结果)
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
  // --- 不再需要加载 lodash ---
  // const L = $substore.libs.lodash; // <--- 已移除

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

  // IP 检测相关参数
  const checkMethod = 'get';
  const checkUrl = 'http://checkip.amazonaws.com';
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

  $.info(`准备通过 HTTP META 检测 ${internalProxies.length} 个兼容节点 (共 ${proxies.length} 个)`);
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
    try {
      body = JSON.parse(body);
    } catch (e) {
        throw new Error(`HTTP META 启动响应解析失败: ${res.body}`);
    }

    if (!body || !body.pid || !body.ports || body.ports.length !== internalProxies.length) {
      throw new Error(`HTTP META 启动失败，响应无效: ${JSON.stringify(body)}`);
    }
    http_meta_pid = body.pid;
    http_meta_ports = body.ports;
    $.info(
      `\n======== HTTP META 启动成功 ====\n[端口范围] ${http_meta_ports[0]} - ${http_meta_ports[http_meta_ports.length - 1]}\n[PID] ${http_meta_pid}\n[核心超时] ${Math.round(http_meta_total_timeout / 600) / 100} 分钟\n========`
    );

    $.info(`等待 ${http_meta_start_delay / 1000} 秒让核心稳定...`);
    await $.wait(http_meta_start_delay);

  } catch (e) {
      $.error(`启动 HTTP META 失败: ${e.message}`);
      $.error("请确保 HTTP META 服务正在运行且配置正确。脚本将不会进行 IP 检测。");
       if (remove_incompatible) {
           return proxies.filter(p => !p._incompatible);
       }
      return proxies; 
  }

  // --- 并发检测 IP ---
  const ipResults = new Array(internalProxies.length);
  await executeAsyncTasks(
    internalProxies.map((proxy, i) => async () => {
      const result = await checkIp(proxy, i);
      ipResults[i] = result; 
    }),
    { concurrency }
  );

  // --- 关闭 HTTP META ---
  try {
      $.info(`正在关闭 HTTP META 实例 (PID: ${http_meta_pid})...`);
      await http({ 
          method: 'post',
          url: `${http_meta_api}/stop`,
          headers: {
              'Content-type': 'application/json',
              'Authorization': http_meta_authorization,
          },
          body: JSON.stringify({
              pid: [http_meta_pid], 
          }),
          timeout: 10000 
      });
      $.info(`======== HTTP META 已关闭 (PID: ${http_meta_pid}) ========`);
  } catch (e) {
      $.error(`关闭 HTTP META (PID: ${http_meta_pid}) 时出错: ${e.message}。可能需要手动检查并停止相关进程。`);
  }

  // --- 处理结果并去重 ---
  const finalProxies = [];
  const seenIps = new Set();
  const processedResults = {}; 
  ipResults.forEach(result => {
      if (result) { 
        processedResults[result.index] = result.ip; 
      }
  });

  for (let i = 0; i < proxies.length; i++) {
      const proxy = proxies[i];
      
      if (remove_incompatible && proxy._incompatible === true) {
          $.info(`移除不兼容节点: ${proxy.name}`);
          continue; 
      }

      const egressIp = processedResults[i]; 

      if (egressIp === null || egressIp === undefined) {
          $.info(`节点 ${proxy.name} 未获取到出口 IP (可能检测失败或不兼容)，将被移除。`);
          continue; 
      }

      if (!seenIps.has(egressIp)) {
          seenIps.add(egressIp);
          const finalProxy = { ...proxy };
          finalProxies.push(finalProxy);
          $.info(`保留节点: ${proxy.name} (IP: ${egressIp})`);
      } else {
          $.info(`移除重复 IP 节点: ${proxy.name} (IP: ${egressIp})`);
      }
  }

  if (!$arguments.incompatible) { 
      finalProxies.forEach(p => delete p._incompatible);
  }

  $.info(`去重完成，剩余 ${finalProxies.length} 个节点。`);
  return finalProxies;

  // --- Helper 函数 ---

  async function checkIp(internalProxy, internalIndex) {
    const originalIndex = internalProxy._original_index;
    const proxyName = proxies[originalIndex].name; 
    const cacheId = cacheEnabled ? getCacheId(internalProxy) : undefined; // 使用修改后的 getCacheId

    try {
        if (cacheEnabled) {
            const cached = cache.get(cacheId);
            if (cached) {
                if (cached.ip) { 
                    $.info(`[${proxyName}] 使用缓存 IP: ${cached.ip}`);
                    return { index: originalIndex, ip: cached.ip };
                } else if (!disableFailedCache) { 
                    $.info(`[${proxyName}] 使用失败缓存`);
                    return { index: originalIndex, ip: null }; 
                } else {
                    $.info(`[${proxyName}] 存在失败缓存，但已禁用`);
                }
            }
        }

        const proxyUrl = `http://${http_meta_host}:${http_meta_ports[internalIndex]}`;
        const res = await http({ 
            proxy: proxyUrl,
            method: checkMethod,
            url: checkUrl,
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'
            },
            timeout: checkTimeout,
            retries: checkRetries,
            retry_delay: checkRetryDelay
        });

        const status = parseInt(res.status || res.statusCode || 0);
        const ip = (res.body || '').trim();

        if (status === 200 && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
            $.info(`[${proxyName}] 检测成功 IP: ${ip}`);
            if (cacheEnabled) {
                $.log(`[${proxyName}] 设置成功缓存: ${ip}`);
                cache.set(cacheId, { ip: ip });
            }
            return { index: originalIndex, ip: ip };
        } else {
            $.warn(`[${proxyName}] IP 检测失败。状态码: ${status}, 响应: "${ip}"`);
            if (cacheEnabled) {
                $.log(`[${proxyName}] 设置失败缓存`);
                cache.set(cacheId, {}); 
            }
            return { index: originalIndex, ip: null }; 
        }

    } catch (e) {
        $.error(`[${proxyName}] IP 检测异常: ${e.message ?? e}`);
        if (cacheEnabled) {
            $.log(`[${proxyName}] 设置失败缓存 (异常)`);
            cache.set(cacheId, {}); 
        }
        return { index: originalIndex, ip: null }; 
    }
  }

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

  /**
   * 生成缓存 ID (无 lodash 依赖版)
   * @param {object} internalProxy - HTTP META 内部格式代理对象
   * @returns {string}
   */
  function getCacheId(internalProxy) {
    const keyData = {};
    // 定义要忽略的固定键和模式
    const omitKeys = ['_original_index', 'name', 'subName', 'id', 'collectionName']; 
    const omitPattern = /^_/i; // 忽略下划线开头的键 (忽略大小写)

    // 手动过滤属性
    for (const key in internalProxy) {
        // 确保是对象自身的属性，并且不在忽略列表/模式中
        if (Object.prototype.hasOwnProperty.call(internalProxy, key)) {
            if (!omitKeys.includes(key) && !omitPattern.test(key)) {
                keyData[key] = internalProxy[key];
            }
        }
    }
    // 使用过滤后的数据生成缓存 ID
    return `deduplicate-ip:${checkUrl}:${JSON.stringify(keyData)}`;
  }


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
              .catch(error => {
                 $.error(`任务 ${taskIndex + 1} 失败: ${error.message}`); 
              })
              .finally(() => {
                running--;
                if (index === tasks.length && running === 0) {
                  resolve(results); 
                } else {
                  executeNextTask(); 
                }
              });
          }
          
           if (index === tasks.length && running === 0) {
                resolve(results);
          }
        }
        executeNextTask(); 
      } catch (e) {
        reject(e);
      }
    });
  }
}
