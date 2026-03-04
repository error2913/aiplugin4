import { Model } from "./model";

export class Agent {
    model: Model;
    desc: string;
    instruction: string;
    sessionService: SessionService;

    constructor(model: Model) {
        this.model = model;
    }

    async chat() {
        
    }
}