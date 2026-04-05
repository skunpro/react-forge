use std::path::PathBuf;

use zed::process::Command;
use zed_extension_api as zed;

struct ReactForge;

impl zed::Extension for ReactForge {
    fn new() -> Self {
        Self
    }

    fn context_server_configuration(
        &mut self,
        context_server_id: &zed::ContextServerId,
        _project: &zed::Project,
    ) -> zed::Result<Option<zed::ContextServerConfiguration>> {
        let context_server_id: &str = context_server_id.as_ref();
        if context_server_id != "react-forge" {
            return Err(format!("Unknown context server: {context_server_id}"));
        }

        Ok(Some(zed::ContextServerConfiguration {
            installation_instructions: "No configuration is required.\n\nOptional settings:\n- logLevel: \"off\" | \"debug\"\n- ignoredDirNames: extra directory names to skip while scanning\n- maxResults: default cap for dependent graph results\n- impactMaxResults: cap used by react_forge_ecosystem_plan impact\n\nIf the server fails to start, ensure Node.js is available to Zed (Settings → Environment) and reinstall the dev extension."
                .to_string(),
            settings_schema: r#"{"type":"object","additionalProperties":false,"properties":{"logLevel":{"type":"string","enum":["off","debug"],"default":"off"},"ignoredDirNames":{"type":"array","items":{"type":"string"},"default":[]},"maxResults":{"type":"number","default":500},"impactMaxResults":{"type":"number","default":500}}}"#.to_string(),
            default_settings: r#"{"logLevel":"off","ignoredDirNames":[],"maxResults":500,"impactMaxResults":500}"#
                .to_string(),
        }))
    }

    fn context_server_command(
        &mut self,
        context_server_id: &zed::ContextServerId,
        _project: &zed::Project,
    ) -> zed::Result<Command> {
        let context_server_id: &str = context_server_id.as_ref();
        if context_server_id != "react-forge" {
            return Err(format!("Unknown context server: {context_server_id}"));
        }

        let node = zed::node_binary_path()?;
        let extension_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let server_path: PathBuf = extension_dir.join("server").join("react-forge-mcp.mjs");

        Ok(Command {
            command: node,
            args: vec![server_path.to_string_lossy().to_string()],
            env: Vec::new(),
        })
    }
}

zed::register_extension!(ReactForge);
