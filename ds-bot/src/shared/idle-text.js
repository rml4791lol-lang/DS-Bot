// Short ack, thanks, closing, and "nothing to do" lines that carry no new work.
// Group relays use this to stop idle loops; Bot chats use it to keep a scheduled
// no-op turn out of the visible transcript.
const ACK_WORDS = "收到|好的|好|明白|明白了|了解|了解了|没问题|谢谢|多谢|感谢|辛苦了|辛苦|不客气|不用谢|好嘞|行|got\\s+it|understood|noted|thanks|thank\\s+you|you\\s+are\\s+welcome|you're\\s+welcome|welcome|np|no\\s+problem|roger|ack"
const IDLE_ACK_WORDS = `${ACK_WORDS}|ok|okay`
const IDLE_CLOSING_WORDS = "完毕|完成|done|all\\s+good|sounds\\s+good"
const IDLE_STATUS_WORDS = [
  '(?:收口)?(?:当前|目前|今日|今天|本轮|本次)*(?:暂无|没有|无)+(?:待办|任务|新进展|新内容|新变化|进展|动作|变化|安排|操作|内容)',
  '(?:本轮|本次)*(?:不|无需)(?:输出|报告|回复)(?:任何)?(?:内容|文字|消息)?',
  '待命', '保持待命', '继续待命', '原地待命', '静候', '静候下一步', '静候指令', '等候指令',
  '等待指令', '等待指示', '等待下一步', '等待安排', '等待新任务', '无事可做', '空转',
  '(?:本轮|本次)(?:不报告|无变化|无更新)',
  'standby', 'standing\\s+by', 'idle', 'nothing\\s+(?:pending|to\\s+do|new)',
  'nothing\\s+to\\s+report(?:\\s+this\\s+turn)?',
  'no\\s+pending\\s+(?:tasks?|work)', 'no\\s+new\\s+(?:work|tasks?|progress|updates?)',
  'no\\s+changes?(?:\\s+this\\s+turn)?', 'no\\s+updates?(?:\\s+this\\s+turn)?',
  'no\\s+action(?:\\s+needed)?', 'this\\s+turn\\s+(?:has\\s+)?no\\s+(?:action|changes?|updates?)',
  'waiting\\s+for\\s+(?:instructions?|the\\s+next\\s+steps?)',
].join('|')
const IDLE_BODY = new RegExp(`^(?:(?:${IDLE_ACK_WORDS}|${IDLE_CLOSING_WORDS}|${IDLE_STATUS_WORDS})(?:[\\s，,、。.!！~～：:；;]+|$))+$`, 'i')
// `ok` and `okay` can be real yes/no answers, so they stay idle-only.
const ACK_BODY = new RegExp(`^(?:(?:${ACK_WORDS}|${IDLE_STATUS_WORDS})(?:[\\s，,、。.!！~～：:；;]+|$))+$`, 'i')
const IDLE_TEXT_MAX = 45

export const normalizeIdleText = text => String(text ?? '')
  .replace(/[\s，,、。.!！?？;；:：'"“”‘’()（）[\]【】~～-]+/g, ' ')
  .trim()
  .toLowerCase()

export const isIdleOnlyText = (text) => {
  const normalized = normalizeIdleText(text)
  return normalized !== '' && normalized.length <= IDLE_TEXT_MAX && IDLE_BODY.test(normalized)
}

// A bare acknowledgement or an idle status, but not a completion word such as
// "done": that word is often the only result a hand-off gets.
export const isAcknowledgementOnlyText = (text) => {
  const normalized = normalizeIdleText(text)
  return normalized !== '' && normalized.length <= IDLE_TEXT_MAX && ACK_BODY.test(normalized)
}

export { IDLE_BODY, IDLE_TEXT_MAX }
