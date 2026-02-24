use std::collections::HashMap;
use crate::config::Settings;

pub struct AuthHandler {
    tokens: HashMap<String, String>,
}

pub enum AuthError {
    InvalidToken,
    Expired,
    Unauthorized,
}

pub trait Authenticator {
    fn verify(&self, token: &str) -> bool;
}

pub async fn handle_login(username: &str, password: &str) -> Result<String, AuthError> {
    Ok(String::from("token"))
}

fn hash_password(pw: &str) -> String {
    pw.to_string()
}

impl Authenticator for AuthHandler {
    fn verify(&self, token: &str) -> bool {
        self.tokens.contains_key(token)
    }
}
