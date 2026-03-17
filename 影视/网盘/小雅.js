// @name 小雅
// @author @sifanss
// @description 必填参数：BASE_URL，XIAOYA_TOKEN
// @dependencies: axios
// @version 1.0.1
// @downloadURL https://gh-proxy.org/https://github.com/Silent1566/OmniBox-Spider/raw/refs/heads/main/影视/网盘/小雅.js

// 引入 OmniBox SDK
const OmniBox = require("omnibox_sdk");

let axios;
try {
  axios = require("axios");
} catch (error) {
  throw new Error("axios 模块未找到,请先安装:npm install axios");
}

const http = require("http");
const https = require("https");

// ==================== 配置区域 ====================
// Alist Tvbox接口地址（支持通过环境变量覆盖）
// 示例：http://127.0.0.1:4567
const BASE_URL = process.env.XIAOYA_BASE_URL || "http://127.0.0.1:4567";

// 小雅接口路径（如有变化可通过环境变量覆盖）
const XIAOYA_TOKEN = process.env.XIAOYA_TOKEN || "";
const VOD_PATH = `/vod1/${XIAOYA_TOKEN}` ;
const PLAY_PATH = `/play/${XIAOYA_TOKEN}`;

// 是否启用本地代理（用于非 115/本地路由播放地址）
const ENABLE_LOCAL_PROXY = (process.env.XIAOYA_ENABLE_PROXY || "1") === "1";
const LOCAL_PROXY_URL = process.env.XIAOYA_PROXY_URL || "http://127.0.0.1:5575/proxy";

// 自定义分类（JSON 字符串，留空则不覆盖）
// 示例：[{"type_id":"1","type_name":"电影"}]
const CUSTOM_CLASS_JSON = process.env.XIAOYA_CLASS_JSON || "";

// ==================== 配置区域结束 ====================

const HTTP_CLIENT = axios.create({
  timeout: 60 * 1000,
  baseURL: BASE_URL,
  httpsAgent: new https.Agent({ keepAlive: true, rejectUnauthorized: false }),
  httpAgent: new http.Agent({ keepAlive: true }),
  validateStatus: (status) => status >= 200,
});

const proxyImageDomains = new Set([
  "img1.doubanio.com",
  "img2.doubanio.com",
  "img3.doubanio.com",
]);

/**
 * 修复图片地址
 */
function fixPicUrl(url) {
  if (!url) return "";
  if (url.startsWith("http")) return url;
  return url.startsWith("/") ? `${BASE_URL}${url}` : `${BASE_URL}/${url}`;
}

/**
 * 图片代理
 */
function processImageUrl(imageUrl, baseURL = "") {
  if (!imageUrl) return "";
  const url = fixPicUrl(imageUrl);
  if (!baseURL || !url.startsWith("http")) return url;

  try {
    const urlObj = new URL(url);
    if (!proxyImageDomains.has(urlObj.hostname)) return url;
    const referer = `${urlObj.protocol}//${urlObj.host}`;
    const urlWithHeaders = `${url}@Referer=${referer}`;
    const encodedUrl = encodeURIComponent(urlWithHeaders);
    return `${baseURL}/api/proxy/image?url=${encodedUrl}`;
  } catch (error) {
    OmniBox.log("warn", `处理图片 URL 失败: ${error.message}`);
    return url;
  }
}

function applyImageProxyToList(list, baseURL = "") {
  if (!Array.isArray(list)) return list;
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    if (item.vod_pic) {
      item.vod_pic = processImageUrl(item.vod_pic, baseURL);
    } else if (item.VodPic) {
      item.VodPic = processImageUrl(item.VodPic, baseURL);
    }
  }
  return list;
}

/**
 * 解析自定义分类配置
 */
function getCustomClasses() {
  if (!CUSTOM_CLASS_JSON) {
    return [];
  }
  try {
    const parsed = JSON.parse(CUSTOM_CLASS_JSON);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch (error) {
    OmniBox.log("warn", `解析自定义分类失败: ${error.message}`);
  }
  return [];
}

/**
 * 发送请求到小雅接口
 */
async function requestXiaoya(path, params = {}) {
  const start = Date.now();
  try {
    OmniBox.log("info", `请求小雅接口: ${path}, params=${JSON.stringify(params)}`);
    const response = await HTTP_CLIENT.get(path, { params });
    const cost = Date.now() - start;
    OmniBox.log("info", `小雅接口响应: ${path}, status=${response.status}, cost=${cost}ms`);
    return response.data;
  } catch (error) {
    const cost = Date.now() - start;
    OmniBox.log("error", `小雅接口请求失败: ${path}, cost=${cost}ms, err=${error.message}`);
    throw error;
  }
}

/**
 * 构建本地代理 URL
 */
function buildLocalProxyUrl(targetUrl) {
  const proxyUrl = new URL(LOCAL_PROXY_URL);
  proxyUrl.searchParams.append("thread", "10");
  proxyUrl.searchParams.append("chunkSize", "256");
  proxyUrl.searchParams.append("url", targetUrl);
  return proxyUrl.toString();
}

/**
 * 处理播放地址
 */
function buildPlayUrls(rawUrl) {
  const urls = [];

  // 先添加原始地址
  urls.push({ name: "RAW", url: rawUrl });

  // 可选本地代理
  if (ENABLE_LOCAL_PROXY && !/115/.test(rawUrl) && !/192\.168\.1\.254/.test(rawUrl)) {
    const proxyUrl = buildLocalProxyUrl(rawUrl);
    urls.unshift({ name: "代理RAW", url: proxyUrl });
  }

  return urls;
}

/**
 * 规范化 filters 的 value 字段 (n -> name, v -> value)
 */
function normalizeFilters(filters) {
  if (!filters || typeof filters !== "object") {
    return filters;
  }

  for (const key of Object.keys(filters)) {
    const group = filters[key];
    if (!Array.isArray(group)) {
      continue;
    }

    for (const item of group) {
      if (!item || !Array.isArray(item.value)) {
        continue;
      }

      item.value = item.value.map((entry) => {
        if (!entry || typeof entry !== "object") {
          return entry;
        }

        if ("name" in entry || "value" in entry) {
          return entry;
        }

        return {
          name: entry.n,
          value: entry.v,
        };
      });
    }
  }

  return filters;
}

/**
 * 将旧格式的播放源转换为新格式（vod_play_sources）
 */
function convertToPlaySources(vodPlayFrom, vodPlayUrl, vodId) {
  const playSources = [];

  if (!vodPlayFrom || !vodPlayUrl) {
    return playSources;
  }

  const sourceNames = vodPlayFrom
    .split("$$$")
    .map((name) => name.trim())
    .filter((name) => name);
  const sourceUrls = vodPlayUrl
    .split("$$$")
    .map((url) => url.trim())
    .filter((url) => url);

  const maxLength = Math.max(sourceNames.length, sourceUrls.length);

  for (let i = 0; i < maxLength; i++) {
    const sourceName = sourceNames[i] || `线路${i + 1}`;
    const sourceUrl = sourceUrls[i] || "";

    let cleanSourceName = sourceName;
    if (vodId && sourceName.endsWith(`-${vodId}`)) {
      cleanSourceName = sourceName.substring(0, sourceName.length - `-${vodId}`.length);
    }

    const episodes = [];
    if (sourceUrl) {
      const episodeSegments = sourceUrl
        .split("#")
        .map((seg) => seg.trim())
        .filter((seg) => seg);

      for (const segment of episodeSegments) {
        const parts = segment.split("$");
        if (parts.length >= 2) {
          const episodeName = parts[0].trim();
          const playId = parts.slice(1).join("$").trim();
          if (episodeName && playId) {
            episodes.push({
              name: episodeName,
              playId: playId,
            });
          }
        } else if (parts.length === 1 && parts[0]) {
          episodes.push({
            name: `第${episodes.length + 1}集`,
            playId: parts[0].trim(),
          });
        }
      }
    }

    if (episodes.length > 0) {
      playSources.push({
        name: cleanSourceName,
        episodes: episodes,
      });
    }
  }

  return playSources;
}

/**
 * 首页
 */
async function home(params, context) {
  try {
    OmniBox.log("info", "获取首页数据");
    const page = params.page || 1;
    const baseURL = context?.baseURL || "";

    const data = await requestXiaoya(VOD_PATH, {
      ac: "list",
      pg: String(page),
    });

    const customClasses = getCustomClasses();
    if (customClasses.length > 0) {
      data.class = customClasses;
      OmniBox.log("info", `使用自定义分类: ${customClasses.length} 项`);
    }

    if (data && data.filters) {
      data.filters = normalizeFilters(data.filters);
    }

    if (data && data.list) {
      applyImageProxyToList(data.list, baseURL);
    }

    return data;
  } catch (error) {
    OmniBox.log("error", `获取首页数据失败: ${error.message}`);
    return { class: [], list: [] };
  }
}

/**
 * 分类
 */
async function category(params, context) {
  try {
    const categoryId = params.categoryId || params.type_id || "";
    const page = params.page || 1;
    const baseURL = context?.baseURL || "";

    if (!categoryId) {
      OmniBox.log("warn", "分类ID为空");
      return { page: 1, pagecount: 0, total: 0, list: [] };
    }

    OmniBox.log("info", `获取分类数据: categoryId=${categoryId}, page=${page}`);

    const data = await requestXiaoya(VOD_PATH, {
      ac: "videolist",
      t: String(categoryId),
      pg: String(page),
    });

    if (data && data.list) {
      applyImageProxyToList(data.list, baseURL);
    }

    return data;
  } catch (error) {
    OmniBox.log("error", `获取分类数据失败: ${error.message}`);
    return { page: 1, pagecount: 0, total: 0, list: [] };
  }
}

/**
 * 搜索
 */
async function search(params, context) {
  try {
    const keyword = params.keyword || params.wd || "";
    const page = params.page || 1;
    const baseURL = context?.baseURL || "";

    if (!keyword) {
      OmniBox.log("warn", "搜索关键词为空");
      return { page: 1, pagecount: 0, total: 0, list: [] };
    }

    OmniBox.log("info", `搜索视频: keyword=${keyword}, page=${page}`);

    const data = await requestXiaoya(VOD_PATH, {
      ac: "list",
      wd: keyword,
      pg: String(page),
    });

    if (data && data.list) {
      applyImageProxyToList(data.list, baseURL);
    }

    return data;
  } catch (error) {
    OmniBox.log("error", `搜索视频失败: ${error.message}`);
    return { page: 1, pagecount: 0, total: 0, list: [] };
  }
}

/**
 * 详情
 */
async function detail(params, context) {
  try {
    const videoId = params.videoId || "";
    const baseURL = context?.baseURL || "";
    if (!videoId) {
      throw new Error("视频ID不能为空");
    }

    OmniBox.log("info", `获取视频详情: videoId=${videoId}`);

    const data = await requestXiaoya(VOD_PATH, {
      ac: "detail",
      ids: String(videoId),
    });

    if (!data || !Array.isArray(data.list) || data.list.length === 0) {
      OmniBox.log("warn", "详情接口返回为空或无列表数据");
      return { list: [] };
    }

    const firstItem = data.list[0] || {};
    const vodPlayFrom = String(firstItem.vod_play_from || firstItem.VodPlayFrom || "");
    const vodPlayUrl = String(firstItem.vod_play_url || firstItem.VodPlayURL || "");

    OmniBox.log(
      "info",
      `详情播放字段: vod_play_from.length=${vodPlayFrom.length}, vod_play_url.length=${vodPlayUrl.length}`
    );

    if (vodPlayFrom && vodPlayUrl) {
      const vodId = String(firstItem.vod_id || firstItem.VodID || videoId);
      const vodPlaySources = convertToPlaySources(vodPlayFrom, vodPlayUrl, vodId);
      OmniBox.log("info", `转换播放源完成: sources=${vodPlaySources.length}`);

      for (const item of data.list) {
        item.vod_play_sources = vodPlaySources;
      }
    } else if (firstItem.vod_play_sources) {
      OmniBox.log("info", "详情已包含 vod_play_sources, 跳过转换");
    } else {
      OmniBox.log("warn", "详情缺少播放字段，可能导致无播放按钮");
    }

    applyImageProxyToList(data.list, baseURL);

    return data;
  } catch (error) {
    OmniBox.log("error", `获取视频详情失败: ${error.message}`);
    return { list: [] };
  }
}

/**
 * 播放
 */
async function play(params) {
  try {
    const playId = params.playId || params.id || "";
    const flag = params.flag || "";

    if (!playId) {
      throw new Error("播放参数不能为空");
    }

    OmniBox.log("info", `获取播放地址: playId=${playId}, flag=${flag}`);

    // 直接播放链接（m3u8/mp4 等）直接返回
    if (/\.(m3u8|mp4|rmvb|avi|wmv|flv|mkv|webm|mov|m3u)(?!\w)/i.test(playId)) {
      return {
        urls: [{ name: "播放", url: playId }],
        flag: flag,
        header: {},
        parse: 0,
      };
    }

    const data = await requestXiaoya(PLAY_PATH, { id: playId });

    if (!data || !data.url) {
      throw new Error("播放接口返回为空");
    }

    const header = typeof data.header === "string" ? JSON.parse(data.header) : data.header || {};
    const urls = buildPlayUrls(data.url);

    return {
      urls,
      flag: flag,
      header,
      parse: 0,
    };
  } catch (error) {
    OmniBox.log("error", `播放接口失败: ${error.message}`);
    return {
      urls: [],
      flag: params.flag || "",
      header: {},
    };
  }
}

module.exports = {
  home,
  category,
  search,
  detail,
  play,
};

const runner = require("spider_runner");
runner.run(module.exports);
