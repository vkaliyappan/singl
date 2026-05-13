declare module 'adm-zip' {
  interface IZipEntry {
    readonly entryName: string;
    readonly isDirectory: boolean;
  }

  class AdmZip {
    constructor(fileNameOrRawData?: string | Buffer);
    getEntries(): IZipEntry[];
    readAsText(entry: IZipEntry | string, encoding?: string): string;
  }

  export = AdmZip;
}
