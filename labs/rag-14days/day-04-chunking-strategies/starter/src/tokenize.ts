/**
 * 中英混合分词。
 *
 * 中文没有空格，所以不能像英文那样按空白切。这里用最省事也最常用的办法：**二元组**（bigram）。
 * 「回收站」切成「回收」「收站」两个词元，查询里出现「回收站」时同样切成这两个词元，
 * 于是不用任何词典就能把它和正文对上。代价是词元数量约等于字数，索引会大一倍左右——
 * 对 30 篇语料完全无所谓，对上亿文档就要换成真正的分词器了。
 *
 * 英文和数字按传统办法处理：转小写、按非字母数字切开。
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  // 先把连续的 CJK 字符与连续的拉丁字母/数字分别切出来，其余字符（标点、空白）当分隔符
  const segments = text.toLowerCase().match(/[一-鿿]+|[a-z0-9]+/g) ?? []
  for (const seg of segments) {
    if (/^[一-鿿]+$/.test(seg)) {
      if (seg.length === 1) {
        tokens.push(seg)
        continue
      }
      for (let i = 0; i + 1 < seg.length; i += 1) tokens.push(seg.slice(i, i + 2))
    } else {
      // 单个字母或数字（a、5）几乎没有区分度，丢掉能省不少索引
      if (seg.length > 1) tokens.push(seg)
    }
  }
  return tokens
}
