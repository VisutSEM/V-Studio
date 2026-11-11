pub struct AppError(anyhow::Error);

impl<E: Into<anyhow::Error>> From<E> for AppError {
    fn from(e: E) -> Self {
        Self(e.into())
    }
}

impl serde::Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&format!("{:#}", self.0))
    }
}

pub type CmdResult<T> = Result<T, AppError>;

pub fn err(msg: impl Into<String>) -> AppError {
    let msg = msg.into();
    AppError(anyhow::anyhow!(msg))
}
