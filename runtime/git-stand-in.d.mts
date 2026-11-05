/** Types for git-stand-in.mjs, which the host imports and the shim copies beside itself. */

export declare const STAND_IN_MARKER: string;
export declare const STAND_IN_DEPTH_ENV: string;
export declare const MAX_STAND_IN_DEPTH: number;
export declare function isMarkedStandIn(file: string): boolean;
export declare function standInDepth(env?: NodeJS.ProcessEnv): number;
export declare function loopStoppedText(): string;
