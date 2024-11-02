import { PonyfillBlob } from './Blob.js';
import { PonyfillFile } from './File.js';
import { PonyfillIteratorObject } from './IteratorObject.js';
import { PonyfillReadableStream } from './ReadableStream.js';

export class PonyfillFormData implements FormData {
  private map = new Map<string, FormDataEntryValue[]>();

  append(name: string, value: string): void;
  append(name: string, value: PonyfillBlob, fileName?: string): void;
  append(name: string, value: PonyfillBlob | string, fileName?: string): void {
    let values = this.map.get(name);
    if (!values) {
      values = [];
      this.map.set(name, values);
    }
    const entry: FormDataEntryValue = isBlob(value)
      ? getNormalizedFile(name, value, fileName)
      : value;
    values.push(entry);
  }

  delete(name: string): void {
    this.map.delete(name);
  }

  get(name: string): FormDataEntryValue | null {
    const values = this.map.get(name);
    return values ? values[0] : null;
  }

  getAll(name: string): FormDataEntryValue[] {
    return this.map.get(name) || [];
  }

  has(name: string): boolean {
    return this.map.has(name);
  }

  set(name: string, value: string): void;
  set(name: string, value: PonyfillBlob, fileName?: string): void;
  set(name: string, value: PonyfillBlob | string, fileName?: string): void {
    const entry: FormDataEntryValue = isBlob(value)
      ? getNormalizedFile(name, value, fileName)
      : value;
    this.map.set(name, [entry]);
  }

  [Symbol.iterator](): FormDataIterator<[string, FormDataEntryValue]> {
    return this._entries();
  }

  *_entries(): FormDataIterator<[string, FormDataEntryValue]> {
    for (const [key, values] of this.map) {
      for (const value of values) {
        yield [key, value];
      }
    }
  }

  entries(): FormDataIterator<[string, FormDataEntryValue]> {
    return new PonyfillIteratorObject(this._entries(), 'FormDataIterator');
  }

  _keys(): IterableIterator<string> {
    return this.map.keys();
  }

  keys(): FormDataIterator<string> {
    return new PonyfillIteratorObject(this._keys(), 'FormDataIterator');
  }

  *_values(): IterableIterator<FormDataEntryValue> {
    for (const values of this.map.values()) {
      for (const value of values) {
        yield value;
      }
    }
  }

  values(): FormDataIterator<FormDataEntryValue> {
    return new PonyfillIteratorObject(this._values(), 'FormDataIterator');
  }

  forEach(callback: (value: FormDataEntryValue, key: string, parent: this) => void): void {
    for (const [key, value] of this) {
      callback(value, key, this);
    }
  }
}

export function getStreamFromFormData(
  formData: FormData,
  boundary = '---',
): PonyfillReadableStream<Uint8Array> {
  const entries: [string, string | PonyfillFile][] = [];
  let sentInitialHeader = false;
  return new PonyfillReadableStream<Buffer>({
    start: controller => {
      formData.forEach((value, key) => {
        if (!sentInitialHeader) {
          controller.enqueue(Buffer.from(`--${boundary}\r\n`));
          sentInitialHeader = true;
        }
        entries.push([key, value as any]);
      });
      if (!sentInitialHeader) {
        controller.enqueue(Buffer.from(`--${boundary}--\r\n`));
        controller.close();
      }
    },
    pull: async controller => {
      const entry = entries.shift();
      if (entry) {
        const [key, value] = entry;
        if (typeof value === 'string') {
          controller.enqueue(Buffer.from(`Content-Disposition: form-data; name="${key}"\r\n\r\n`));
          controller.enqueue(Buffer.from(value));
        } else {
          let filenamePart = '';
          if (value.name) {
            filenamePart = `; filename="${value.name}"`;
          }
          controller.enqueue(
            Buffer.from(`Content-Disposition: form-data; name="${key}"${filenamePart}\r\n`),
          );
          controller.enqueue(
            Buffer.from(`Content-Type: ${value.type || 'application/octet-stream'}\r\n\r\n`),
          );
          const entryStream = value.stream();
          for await (const chunk of entryStream) {
            controller.enqueue(chunk);
          }
        }
        if (entries.length === 0) {
          controller.enqueue(Buffer.from(`\r\n--${boundary}--\r\n`));
          controller.close();
        } else {
          controller.enqueue(Buffer.from(`\r\n--${boundary}\r\n`));
        }
      } else {
        controller.enqueue(Buffer.from(`\r\n--${boundary}--\r\n`));
        controller.close();
      }
    },
  });
}

function getNormalizedFile(name: string, blob: PonyfillBlob, fileName?: string) {
  Object.defineProperty(blob as PonyfillFile, 'name', {
    configurable: true,
    enumerable: true,
    value: fileName || blob.name || name,
  });
  return blob as PonyfillFile;
}

function isBlob(value: any): value is PonyfillBlob {
  return value?.arrayBuffer != null;
}
