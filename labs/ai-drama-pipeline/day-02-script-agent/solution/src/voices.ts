// MiniMax 系统音色白名单。
// 这些 id 取自官方《系统音色列表》，其中 badao_shaoye 已用真 key 实测合成成功。
// 为什么要有这张表：2026-09-07 实测发现，如果提示词不给候选，模型会**凭空编**出
// male_young_01 这类看起来很合理但根本不存在的 id，到 D5 真正合成时才报错。
// 所以音色必须是「从白名单里选」，不是「让模型自由填」。

/** 按角色气质给离线模拟器用的关键词映射。 */
export const MALE_VOICES: [string, string][] = [
  ['总裁', 'badao_shaoye'],
  ['少爷', 'badao_shaoye'],
  ['老板', 'badao_shaoye'],
  ['学长', 'lengdan_xiongzhang'],
  ['学弟', 'chunzhen_xuedi'],
  ['弟弟', 'bingjiao_didi'],
]

export const FEMALE_VOICES: [string, string][] = [
  ['御姐', 'wumei_yujie'],
  ['学姐', 'danya_xuejie'],
  ['学妹', 'diadia_xuemei'],
  ['萌妹', 'qiaopi_mengmei'],
]

/** 允许出现在人物卡里的全部音色 id。校验与提示词都以这一份为准。 */
export const VOICE_IDS: readonly string[] = [
  'badao_shaoye',
  'junlang_nanyou',
  'bingjiao_didi',
  'lengdan_xiongzhang',
  'chunzhen_xuedi',
  'wumei_yujie',
  'tianxin_xiaoling',
  'qiaopi_mengmei',
  'diadia_xuemei',
  'danya_xuejie',
  'male-qn-qingse',
  'male-qn-jingying',
  'female-shaonv',
  'female-yujie',
  'female-chengshu',
  'female-tianmei',
]
