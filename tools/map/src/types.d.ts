declare module 'mapshaper' {
  const mapshaper: {
    applyCommands(
      cmd: string,
      input?: Record<string, unknown>,
    ): Promise<Record<string, Buffer | string>>;
  };
  export default mapshaper;
}
