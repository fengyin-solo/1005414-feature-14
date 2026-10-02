// 极简 zip 打包：只用 STORE（不压缩）条目，够把几沓评估材料打成一个文件直接发出去。
// 不引第三方依赖，自己算 CRC32、拼本地文件头 + 中央目录 + 结尾记录。

export type ZipEntry = { name: string; content: string }

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(now: Date): { date: number; time: number } {
  const time = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff
  const year = Math.max(now.getFullYear(), 1980)
  const date = (((year - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff
  return { date, time }
}

export function buildZip(entries: ZipEntry[], now: Date = new Date()): Blob {
  const encoder = new TextEncoder()
  // encode 出来的字节数组拷贝一份，保证底层是普通 ArrayBuffer，才能直接喂给 Blob。
  const encode = (text: string): Uint8Array<ArrayBuffer> => {
    const bytes = encoder.encode(text)
    const copy = new Uint8Array(bytes.length)
    copy.set(bytes)
    return copy
  }
  const { date, time } = dosDateTime(now)
  const body: Uint8Array<ArrayBuffer>[] = []
  const central: Uint8Array<ArrayBuffer>[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = encode(entry.name)
    const data = encode(entry.content)
    const crc = crc32(data)

    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true) // 本地文件头签名
    local.setUint16(4, 20, true) // 解压所需版本
    local.setUint16(6, 0x0800, true) // 标志位：文件名按 UTF-8 解码
    local.setUint16(8, 0, true) // 压缩方式：STORE
    local.setUint16(10, time, true)
    local.setUint16(12, date, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, data.length, true)
    local.setUint32(22, data.length, true)
    local.setUint16(26, nameBytes.length, true)
    local.setUint16(28, 0, true) // 扩展字段长度
    body.push(new Uint8Array(local.buffer), nameBytes, data)

    const record = new DataView(new ArrayBuffer(46))
    record.setUint32(0, 0x02014b50, true) // 中央目录签名
    record.setUint16(4, 20, true) // 制作版本
    record.setUint16(6, 20, true) // 解压所需版本
    record.setUint16(8, 0x0800, true)
    record.setUint16(10, 0, true)
    record.setUint16(12, time, true)
    record.setUint16(14, date, true)
    record.setUint32(16, crc, true)
    record.setUint32(20, data.length, true)
    record.setUint32(24, data.length, true)
    record.setUint16(28, nameBytes.length, true)
    record.setUint32(42, offset, true) // 对应本地文件头的偏移
    central.push(new Uint8Array(record.buffer), nameBytes)

    offset += 30 + nameBytes.length + data.length
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true) // 结尾记录签名
  end.setUint16(8, entries.length, true)
  end.setUint16(10, entries.length, true)
  end.setUint32(12, centralSize, true)
  end.setUint32(16, offset, true)

  return new Blob([...body, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' })
}
