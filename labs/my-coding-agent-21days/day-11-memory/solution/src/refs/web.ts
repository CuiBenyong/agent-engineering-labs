/**
 * 网址引用：抓取 + 正文提取 + 失败降级。本天新增。
 *
 * 三件事各有一条纪律：
 *
 * 一、**抓取要有超时、大小上限和内容类型检查，三样都不能省。**
 *    没超时会把一轮对话挂在一个不响应的服务器上；没大小上限，一个几十兆的页面
 *    会直接把预算冲光（而且是在你算预算之前就已经进内存了）；不看内容类型，
 *    你会把一个 PDF 或者一张图的字节当成文本注进去。
 *
 * 二、**正文提取做到「能用」就够，不引第三方库。** 目标不是完美还原文章结构，
 *    而是「把导航、脚本、样式去掉，留下能读的段落」。做法是三步：先整块删掉
 *    script 与 style，再把标签换成空白，最后压掉连续空白。这套办法在结构良好的
 *    文档页上效果不错，在重前端渲染的页面上会拿到一堆空壳——那时候的正确反应是
 *    降级并说清楚，不是硬猜。
 *
 * 三、**失败要降级成一句人话，而不是崩掉整轮。** 抓不到就告诉用户抓不到、
 *    为什么，并且建议他把内容贴进来。一次抓取失败不该让他重打整句话。
 *
 * 离线模式（MOCK=1）不发任何网络请求，返回一个内置的样例页——所以这一条链路
 * 在没有网的机器上也能验，抽正文那一段逻辑跑的还是同一份代码。
 */

const FETCH_TIMEOUT_MS = 8000
const MAX_BYTES = 512_000

/** 离线模式下的样例页：故意带上脚本、样式、导航，好让正文提取有活干 */
const SAMPLE_PAGE = `<!doctype html>
<html><head><title>calc-demo 的除法约定</title>
<style>body{font:14px system-ui}</style>
<script>window.analytics = 1</script>
</head><body>
<nav>首页 / 文档 / 关于</nav>
<h1>除法约定</h1>
<p>divide(a, b) 在 b 为 0 时必须抛出错误，错误信息里要含有 zero 这个词。</p>
<p>调用方不要依赖 Infinity 这个返回值：它会让错误在很远的地方才被发现。</p>
<script>console.log('tracking')</script>
</body></html>`

export interface FetchedPage {
  ok: boolean
  title: string
  text: string
  problem?: string
}

export async function fetchPage(url: string, signal?: AbortSignal): Promise<FetchedPage> {
  if (process.env.MOCK === '1') {
    return { ok: true, title: titleOf(SAMPLE_PAGE) ?? url, text: extractText(SAMPLE_PAGE) }
  }

  try {
    const res = await fetch(url, {
      signal: signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'text/html,text/plain;q=0.9,*/*;q=0.1' },
    })
    if (!res.ok) {
      return { ok: false, title: url, text: '', problem: `抓取失败：HTTP ${res.status}` }
    }
    const type = res.headers.get('content-type') ?? ''
    if (!/text\/|json|xml/i.test(type)) {
      return {
        ok: false,
        title: url,
        text: '',
        problem: `不是文本类型（${type.split(';')[0] || '未知'}），没有注入。图片与 PDF 请另想办法`,
      }
    }
    const raw = await readCapped(res)
    const text = /html/i.test(type) ? extractText(raw) : collapse(raw)
    if (text.length < 40) {
      // 抓到了，但抽不出正文：多半是靠前端渲染的页面。说清楚，不硬猜
      return {
        ok: false,
        title: titleOf(raw) ?? url,
        text: '',
        problem: '抓到了页面但抽不出正文（可能是前端渲染的页面），建议直接把内容贴进来',
      }
    }
    return { ok: true, title: titleOf(raw) ?? url, text }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, title: url, text: '', problem: `抓取失败：${detail}` }
  }
}

/** 读到上限就停：不要先读完再截，那时候内存已经花掉了 */
async function readCapped(res: Response): Promise<string> {
  if (!res.body) return ''
  const decoder = new TextDecoder()
  let text = ''
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    text += decoder.decode(chunk, { stream: true })
    if (text.length >= MAX_BYTES) return text.slice(0, MAX_BYTES)
  }
  return text
}

export function titleOf(html: string): string | null {
  return /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() || null
}

/**
 * 三步提取正文。顺序很重要：先删整块的 script 与 style，
 * 否则第二步把标签换成空白之后，脚本代码会变成正文。
 */
export function extractText(html: string): string {
  const withoutBlocks = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
  // 块级标签换成换行，其余换成空格：段落感能留住一点
  const withBreaks = withoutBlocks
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  return collapse(decodeEntities(withBreaks))
}

function decodeEntities(text: string): string {
  const table: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&nbsp;': ' ',
  }
  return text.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => table[m] ?? m)
}

/** 压掉连续空白：抽完标签之后满屏都是空格 */
function collapse(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}
