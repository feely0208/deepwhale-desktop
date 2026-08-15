/**
 * tree-kill 类型声明（该包未内置 TS 类型）。
 * 跨平台杀进程树：kill(pid, signal?, callback?)
 */
declare module 'tree-kill' {
  function kill(
    pid: number,
    signal?: string | number,
    callback?: (err?: Error) => void
  ): void;
  export = kill;
}
