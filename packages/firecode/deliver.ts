/**
 * 统一投递入口（Master 事件与观察员发言共用）：宿主流式中投自定义卡片、经
 * steer 队列在句缝送达；会话歇透时改走 sendUserMessage 前门唤起——宿主的
 * triggerTurn 唤醒会跳过 before_agent_start（上游缺陷，#33），前门唤醒自带
 * 完整开跑仪式，系统提示注入不随回合抖动。
 *
 * 忙闲判断与发送必须在同一事件循环节拍内完成，两者之间禁止 await：会话落定
 * 是下一节拍的事件，同节拍读到的忙闲不会骑墙；宿主在回合结束前清空 steer
 * 队列，忙时入队的消息以同回合续跑送达，不会沦为唤醒者。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface Envelope<T> {
	customType: string;
	content: string;
	details?: T;
}

export async function deliver<T>(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	envelope: Envelope<T>,
): Promise<void> {
	if (ctx.isIdle?.() === true) {
		await pi.sendUserMessage(envelope.content);
		return;
	}
	pi.sendMessage<T>(
		{ customType: envelope.customType, content: envelope.content, display: true, details: envelope.details },
		{ deliverAs: "steer" },
	);
}
