export class Session {
    sid: string;
    state: any;
    memory: Memory;
}

export class SessionService {
    sessionMap: { [key: string]: Session };

    constructor() {

    }
}