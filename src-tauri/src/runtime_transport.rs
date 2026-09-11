use std::io;

use serde_json::Value;

pub struct JsonLinesDecoder {
    buffer: Vec<u8>,
    max_frame_bytes: usize,
}

impl JsonLinesDecoder {
    pub fn new(max_frame_bytes: usize) -> io::Result<Self> {
        if max_frame_bytes == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "maximum frame size must be positive",
            ));
        }
        Ok(Self {
            buffer: Vec::new(),
            max_frame_bytes,
        })
    }

    pub fn push(&mut self, bytes: &[u8]) -> io::Result<Vec<Value>> {
        let mut frames = Vec::new();
        for chunk in bytes.split_inclusive(|byte| *byte == b'\n') {
            let terminated = chunk.last() == Some(&b'\n');
            let content = if terminated {
                &chunk[..chunk.len() - 1]
            } else {
                chunk
            };
            if self.buffer.len().saturating_add(content.len()) > self.max_frame_bytes {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "JSON-lines frame exceeds the configured limit",
                ));
            }
            self.buffer.extend_from_slice(content);
            if !terminated {
                continue;
            }
            let line = self.buffer.strip_suffix(b"\r").unwrap_or(&self.buffer);
            if line.iter().all(u8::is_ascii_whitespace) {
                self.buffer.clear();
                continue;
            }
            let value = serde_json::from_slice(line).map_err(|error| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("invalid JSON frame: {error}"),
                )
            })?;
            frames.push(value);
            self.buffer.clear();
        }
        if self.buffer.len() > self.max_frame_bytes {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "JSON-lines frame exceeds the configured limit",
            ));
        }
        Ok(frames)
    }

    pub fn finish(self) -> io::Result<Vec<Value>> {
        if self.buffer.iter().all(u8::is_ascii_whitespace) {
            return Ok(Vec::new());
        }
        Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "JSON-lines stream ended with an incomplete frame",
        ))
    }
}

pub fn encode_json_line(value: &Value) -> io::Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec(value).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("could not encode JSON frame: {error}"),
        )
    })?;
    bytes.push(b'\n');
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::{encode_json_line, JsonLinesDecoder};
    use serde_json::json;

    #[test]
    fn decodes_split_crlf_frames_and_ignores_blank_lines() {
        let mut decoder = JsonLinesDecoder::new(128).expect("decoder");
        assert!(decoder
            .push(b"\n {\"id\":")
            .expect("first chunk")
            .is_empty());
        let frames = decoder
            .push(b"1}\r\n{\"ready\":true}\n")
            .expect("second chunk");
        assert_eq!(frames, vec![json!({"id": 1}), json!({"ready": true})]);
        assert!(decoder.finish().expect("complete stream").is_empty());
    }

    #[test]
    fn rejects_invalid_and_incomplete_frames() {
        let mut invalid = JsonLinesDecoder::new(128).expect("decoder");
        assert!(invalid.push(b"{broken}\n").is_err());

        let mut incomplete = JsonLinesDecoder::new(128).expect("decoder");
        incomplete.push(b"{\"id\": 1}").expect("partial frame");
        assert!(incomplete.finish().is_err());
    }

    #[test]
    fn bounds_unterminated_frames() {
        let mut decoder = JsonLinesDecoder::new(4).expect("decoder");
        assert!(decoder.push(b"12345").is_err());
    }

    #[test]
    fn bounds_each_frame_without_rejecting_coalesced_input() {
        let mut decoder = JsonLinesDecoder::new(8).expect("decoder");
        decoder.push(br#"{"a":1}"#).expect("partial frame");
        let frames = decoder
            .push(
                br#"
{"b":2}
"#,
            )
            .expect("coalesced frames");
        assert_eq!(frames, vec![json!({"a": 1}), json!({"b": 2})]);
    }

    #[test]
    fn encodes_one_newline_terminated_frame() {
        assert_eq!(
            encode_json_line(&json!({"cmd": "getStatus"})).expect("encoded frame"),
            br#"{"cmd":"getStatus"}
"#
        );
    }
}
