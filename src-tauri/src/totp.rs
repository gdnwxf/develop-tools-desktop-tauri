use hmac::{Hmac, Mac};
use sha1::Sha1;

pub fn generate(secret: &str, time: u64) -> Result<String, String> {
    let clean: String = secret
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '=')
        .flat_map(char::to_uppercase)
        .collect();
    let alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut bytes = Vec::new();
    let (mut bits, mut count) = (0u32, 0u32);
    for ch in clean.chars() {
        let n = alphabet.find(ch).ok_or("optsecret 含非 Base32 字符")? as u32;
        bits = (bits << 5) | n;
        count += 5;
        if count >= 8 {
            count -= 8;
            bytes.push((bits >> count) as u8);
            bits &= (1 << count) - 1;
        }
    }
    if bytes.len() < 10 {
        return Err("optsecret 解码后长度不足".into());
    }
    let mut mac = Hmac::<Sha1>::new_from_slice(&bytes).map_err(|_| "TOTP 密钥无效")?;
    mac.update(&(time / 30).to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let offset = (digest[19] & 15) as usize;
    let value = u32::from_be_bytes([
        digest[offset] & 127,
        digest[offset + 1],
        digest[offset + 2],
        digest[offset + 3],
    ]);
    Ok(format!("{:06}", value % 1_000_000))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rfc_6238_six_digit_vectors() {
        let key = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
        for (time, code) in [
            (59, "287082"),
            (1111111109, "081804"),
            (1111111111, "050471"),
            (1234567890, "005924"),
            (2000000000, "279037"),
            (20000000000, "353130"),
        ] {
            assert_eq!(generate(key, time).unwrap(), code);
        }
        assert!(generate("bad!", 0).is_err());
        assert!(generate("AA", 0).is_err());
        assert_eq!(generate(&key.to_lowercase(), 59).unwrap(), "287082");
    }
}
