import { NAME } from "./config/static_config";
import { Config } from "./config/config";

class Logger {
    name: string;
    constructor(name: string) {
        this.name = name;
    }

    handleLog(...data: any[]): string {
        const { logLevel } = Config.base;
        if (logLevel === "永不") {
            return '';
        } else if (logLevel === "简短") {
            const s = data.map(item => `${item}`).join(" ");
            if (s.length > 1000) {
                return s.substring(0, 500) + "\n...\n" + s.substring(s.length - 500);
            } else {
                return s;
            }
        } else if (logLevel === "详细" || logLevel === "调试") {
            return data.map(item => `${item}`).join(" ");
        } else {
            return '';
        }
    }

    info(...data: any[]) {
        const s = this.handleLog(...data);
        if (!s) {
            return;
        }
        console.log(`【${this.name}】: ${s}`);
    }

    warning(...data: any[]) {
        const s = this.handleLog(...data);
        if (!s) {
            return;
        }
        console.warn(`【${this.name}】: ${s}`);
    }

    error(...data: any[]) {
        const s = this.handleLog(...data);
        if (!s) {
            return;
        }
        console.error(`【${this.name}】: ${s}`);
    }

    debug(...data: any[]) {
        const { logLevel } = Config.base;
        if (logLevel !== "调试") return;
        const s = this.handleLog(...data);
        if (!s) {
            return;
        }
        console.info(`【${this.name}】: ${s}`);
    }
}

export const logger = new Logger(NAME);