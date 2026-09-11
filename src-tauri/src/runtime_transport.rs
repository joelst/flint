use std::io;

use serde_json::Value;

pub struct JsonLinesDecoder {
    buffer: Vec<u8>,
    max_frame_bytes: usize,
    pending_cr: bool,
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
            pending_cr: false,
        })
    }

    pub fn push(&mut self, bytes: &[u8]) -> io::Result<Vec<Value>> {
        let mut frames = Vec::new();
        for byte in bytes {
            if self.pending_cr {
                self.pending_cr = false;
                if *byte == b'\n' {
                    self.decode_buffer(&mut frames)?;
                    continue;
                }
                self.append_byte(b'\r')?;
            }
            match *byte {
                b'\r' => self.pending_cr = true,
                b'\n' => self.decode_buffer(&mut frames)?,
                byte => self.append_byte(byte)?,
            }
        }
        if self.buffer.len() > self.max_frame_bytes {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "JSON-lines frame exceeds the configured limit",
            ));
        }
        Ok(frames)
    }

    fn append_byte(&mut self, byte: u8) -> io::Result<()> {
        if self.buffer.len() >= self.max_frame_bytes {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "JSON-lines frame exceeds the configured limit",
            ));
        }
        self.buffer.push(byte);
        Ok(())
    }

    fn decode_buffer(&mut self, frames: &mut Vec<Value>) -> io::Result<()> {
        let line = self.buffer.strip_suffix(b"\r").unwrap_or(&self.buffer);
        if line.iter().copied().all(is_json_whitespace) {
            self.buffer.clear();
            return Ok(());
        }
        let value = serde_json::from_slice(line).map_err(|error| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("invalid JSON frame: {error}"),
            )
        })?;
        frames.push(value);
        self.buffer.clear();
        Ok(())
    }

    pub fn finish(self) -> io::Result<Vec<Value>> {
        if self.pending_cr {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "JSON-lines stream ended after a carriage return",
            ));
        }
        if self.buffer.iter().copied().all(is_json_whitespace) {
            return Ok(Vec::new());
        }
        Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "JSON-lines stream ended with an incomplete frame",
        ))
    }
}

fn is_json_whitespace(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\r' | b'\n')
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
        assert!(invalid.push(b"\x0b\n").is_err());

        let mut incomplete = JsonLinesDecoder::new(128).expect("decoder");
        incomplete.push(b"{\"id\": 1}").expect("partial frame");
        assert!(incomplete.finish().is_err());
        let mut invalid_trailing = JsonLinesDecoder::new(128).expect("decoder");
        invalid_trailing
            .push(b"\x0c")
            .expect("partial invalid frame");
        assert!(invalid_trailing.finish().is_err());

        let mut incomplete_crlf = JsonLinesDecoder::new(128).expect("decoder");
        incomplete_crlf.push(b"\r").expect("partial CRLF");
        assert!(incomplete_crlf.finish().is_err());
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
    fn treats_lf_and_crlf_as_the_same_frame_size() {
        let mut lf = JsonLinesDecoder::new(7).expect("LF decoder");
        assert_eq!(
            lf.push(b"{\"a\":1}\n").expect("LF frame"),
            vec![json!({"a": 1})]
        );

        let mut crlf = JsonLinesDecoder::new(7).expect("CRLF decoder");
        assert_eq!(
            crlf.push(b"{\"a\":1}\r\n").expect("CRLF frame"),
            vec![json!({"a": 1})]
        );

        let mut split = JsonLinesDecoder::new(7).expect("split CRLF decoder");
        assert!(split
            .push(b"{\"a\":1}\r")
            .expect("split payload")
            .is_empty());
        assert_eq!(
            split.push(b"\n").expect("split terminator"),
            vec![json!({"a": 1})]
        );
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
