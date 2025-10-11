const cmdArray = [
    {
        arg: ["ai", "AI"], argsArray: [
            { arg: ["st"], argsArray: [] },
            { arg: ["ck"], argsArray: [] },
            { arg: ["prompt"], argsArray: [] },
            { arg: ["status"], argsArray: [] },
            { arg: ["ctxn"], argsArray: [] },
            {
                arg: ["timer"], argsArray: [
                    { arg: ["clr"], argsArray: [] }
                ]
            },
            { arg: ["on"], argsArray: [] },
            { arg: ["sb"], argsArray: [] },
            { arg: ["off"], argsArray: [] },
            {
                arg: ["f", "fgt"], argsArray: [
                    { arg: ["ass", "assistant"], argsArray: [] },
                    { arg: ["user"], argsArray: [] }
                ]
            },
            { arg: ["role"], argsArray: [] },
            {
                arg: ["memo"], argsArray: [
                    { arg: ["status"], argsArray: [] },
                    {
                        arg: ["p", "private"], argsArray: [
                            {
                                arg: ["st"], argsArray: [
                                    { arg: ["clr"], argsArray: [] },
                                ]
                            },
                            { arg: ["del"], argsArray: [] },
                            { arg: ["show"], argsArray: [] },
                            { arg: ["clr"], argsArray: [] }
                        ]
                    },
                    {
                        arg: ["g", "group"], argsArray: [
                            {
                                arg: ["st"], argsArray: [
                                    { arg: ["clr"], argsArray: [] },
                                ]
                            },
                            { arg: ["del"], argsArray: [] },
                            { arg: ["show"], argsArray: [] },
                            { arg: ["clr"], argsArray: [] }
                        ]
                    },
                    {
                        arg: ["s", "short"], argsArray: [
                            { arg: ["show"], argsArray: [] },
                            { arg: ["clr"], argsArray: [] }
                        ]
                    },
                    { arg: ["sum"], argsArray: [] }
                ]
            },
            {
                arg: ["tool"], argsArray: [
                    { arg: ["help"], argsArray: [] },
                    { arg: ["on"], argsArray: [] },
                    { arg: ["off"], argsArray: [] }
                ]
            },
            {
                arg: ["ign"], argsArray: [
                    { arg: ["add"], argsArray: [] },
                    { arg: ["rm"], argsArray: [] },
                    { arg: ["list"], argsArray: [] }
                ]
            },
            {
                arg: ["tk"], argsArray: [
                    { arg: ["lst"], argsArray: [] },
                    { arg: ["sum"], argsArray: [] },
                    { arg: ["all"], argsArray: [] },
                    {
                        arg: ["y"], argsArray: [
                            { arg: ["chart"], argsArray: [] }
                        ]
                    },
                    {
                        arg: ["m"], argsArray: [
                            { arg: ["chart"], argsArray: [] }
                        ]
                    },
                    { arg: ["clr"], argsArray: [] }
                ]
            },
            { arg: ["shut"], argsArray: [] }
        ]
    },
    {
        arg: ["img"], argsArray: [
            {
                arg: ["draw"], argsArray: [
                    { arg: ["lcl", "local"], argsArray: [] },
                    { arg: ["stl", "stolen"], argsArray: [] },
                    { arg: ["save"], argsArray: [] },
                    { arg: ["all"], argsArray: [] }
                ]
            },
            {
                arg: ["stl", "steal"], argsArray: [
                    { arg: ["on"], argsArray: [] },
                    { arg: ["off"], argsArray: [] }
                ]
            },
            {
                arg: ["f", "fgt", "forget"], argsArray: [
                    { arg: ["stl", "stolen"], argsArray: [] },
                    { arg: ["save"], argsArray: [] },
                    { arg: ["all"], argsArray: [] }
                ]
            },
            {
                arg: ["itt"], argsArray: [
                    { arg: ["ran"], argsArray: [] }
                ]
            },
            {
                arg: ["save"], argsArray: [
                    { arg: ["show"], argsArray: [] },
                    { arg: ["clr"], argsArray: [] },
                    { arg: ["del"], argsArray: [] }
                ]
            }
        ]
    },
];

export class PrivilegeManager {
    static validKeys: (keyof PrivilegeManager)[] = [];

}