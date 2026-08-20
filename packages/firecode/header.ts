/** 会话启动横幅：终端够宽显示火焰 + FireCode 字标，否则退化成一行。 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { clip } from "./format.js";
import { ANSI, FLAME } from "./theme.js";

const GAP = "     ";
const EXTRA_RIGHT_PAD = " ";
/** 字标相对火焰顶部下沉的行数 */
const TEXT_TOP_PAD = 4;

const FLAME_ART = [
	"⠀⠀⠀⠀⠀⠀⢱⣆⠀⠀⠀⠀⠀⠀",
	"⠀⠀⠀⠀⠀⠀⠈⣿⣷⡀⠀⠀⠀⠀",
	"⠀⠀⠀⠀⠀⠀⢸⣿⣿⣷⣧⠀⠀⠀",
	"⠀⠀⠀⠀⡀⢠⣿⡟⣿⣿⣿⡇⠀⠀",
	"⠀⠀⠀⠀⣳⣼⣿⡏⢸⣿⣿⣿⢀⠀",
	"⠀⠀⠀⣰⣿⣿⡿⠁⢸⣿⣿⡟⣼⡆",
	"⢰⢀⣾⣿⣿⠟⠀⠀⣾⢿⣿⣿⣿⣿",
	"⢸⣿⣿⣿⡏⠀⠀⠀⠃⠸⣿⣿⣿⡿",
	"⢳⣿⣿⣿⠀⠀⠀⠀⠀⠀⢹⣿⡿⡁",
	"⠀⠹⣿⣿⡄⠀⠀⠀⠀⠀⢠⣿⡞⠁",
	"⠀⠀⠈⠛⢿⣄⠀⠀⠀⣠⠞⠋⠀⠀",
];
const WORDMARK = [
	"___________.__                 _________            .___      ",
	"\\_   _____/|__|______   ____   \\_   ___ \\  ____   __| _/____  ",
	" |    __)  |  \\_  __ \\_/ __ \\  /    \\  \\/ /  _ \\ / __ |/ __ \\ ",
	" |     \\   |  ||  | \\/\\  ___/  \\     \\___(  <_> ) /_/ \\  ___/ ",
	" \\___  /   |__||__|    \\___  >  \\______  /\\____/\\____ |\\___  >",
	"     \\/                    \\/          \\/            \\/    \\/ ",
];
const FLAME_COLORS = [
	FLAME.red,
	FLAME.red,
	FLAME.orange,
	FLAME.orange,
	FLAME.gold,
	FLAME.white,
	FLAME.white,
	FLAME.gold,
	FLAME.orange,
	FLAME.red,
	FLAME.red,
];
const TEXT_COLORS = [
	FLAME.textTop,
	FLAME.textTop,
	FLAME.textMid,
	FLAME.textCore,
	FLAME.gold,
	FLAME.gold,
];

function padToWidth(line: string, width: number): string {
	return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
}

const FLAME_WIDTH = Math.max(...FLAME_ART.map(visibleWidth));
const FULL_WIDTH = Math.max(
	...FLAME_ART.map((flame, index) => {
		const text = WORDMARK[index - TEXT_TOP_PAD] ?? "";
		return visibleWidth(`${padToWidth(flame, FLAME_WIDTH)}${GAP}${text}${EXTRA_RIGHT_PAD}`);
	}),
);
const FULL = FLAME_ART.map((art, index) => {
	const textIndex = index - TEXT_TOP_PAD;
	const wordmark = WORDMARK[textIndex] ?? "";
	const flame = `${FLAME_COLORS[index]}${padToWidth(art, FLAME_WIDTH)}${ANSI.reset}`;
	const title = wordmark
		? `${ANSI.bold}${TEXT_COLORS[textIndex]}${wordmark}${ANSI.reset}`
		: "";
	return padToWidth(`${flame}${GAP}${title}`, FULL_WIDTH);
});
const TINY = [`${FLAME.orange}🔥 Fire${ANSI.reset} ${FLAME.textCore}Code${ANSI.reset}`];

function center(line: string, width: number): string {
	const clipped = clip(line, width, "end", "");
	return " ".repeat(Math.max(0, Math.floor((width - visibleWidth(clipped)) / 2))) + clipped;
}

export function registerHeader(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setHeader(() => ({
			invalidate() {},
			render(width: number): string[] {
				const lines = width >= FULL_WIDTH ? FULL : TINY;
				return ["", ...lines.map((line) => center(line, width)), ""];
			},
		}));
	});
}
