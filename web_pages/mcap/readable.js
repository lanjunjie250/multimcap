/** Bounded, cached local Blob reads; never reads the complete recording at once. */
export class FileReadable {
  constructor(file, {windowBytes = 4 * 1024 * 1024, maxReadBytes = 32 * 1024 * 1024} = {}) {
    if (!Number.isSafeInteger(file.size)) throw Error('文件大小超出浏览器可安全定位的范围');
    this.file = file;
    this.size = file.size;
    this.windowBytes = windowBytes;
    this.maxReadBytes = maxReadBytes;
    this.cache = new Uint8Array();
    this.cacheOffset = 0;
    this.bytesRead = 0;
    this.closed = false;
  }
  async read(offset, length) {
    if (this.closed) throw new DOMException('文件已关闭', 'AbortError');
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 ||
        length > this.maxReadBytes || offset > this.size - length) throw Error('MCAP 读取范围越界或单条消息超过 32 MiB');
    if (!length) return new Uint8Array();
    if (offset >= this.cacheOffset && offset + length <= this.cacheOffset + this.cache.length) {
      return this.cache.subarray(offset - this.cacheOffset, offset - this.cacheOffset + length);
    }
    const count = Math.min(this.size - offset, Math.max(this.windowBytes, length));
    const bytes = new Uint8Array(await this.file.slice(offset, offset + count).arrayBuffer());
    if (this.closed) throw new DOMException('文件已关闭', 'AbortError');
    if (bytes.length !== count) throw Error('本地文件读取不完整');
    this.bytesRead += count;
    this.cache = bytes;
    this.cacheOffset = offset;
    return bytes.subarray(0, length);
  }
  close() { this.closed = true; this.file = null; this.cache = new Uint8Array(); }
}
