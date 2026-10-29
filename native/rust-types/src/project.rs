use anyhow::{Context, Result, bail};
use ra_ap_ide_db::{RootDatabase, base_db::SourceDatabase};
use ra_ap_load_cargo::{LoadCargoConfig, ProcMacroServerChoice, load_workspace_at};
use ra_ap_project_model::{CargoConfig, CargoFeatures, RustLibSource};
use ra_ap_vfs::{Vfs, VfsPath};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
};

fn fingerprint(path: &Path) -> Result<Option<u64>> {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    if path.is_dir() {
        let mut names = std::fs::read_dir(path)?
            .map(|entry| entry.map(|entry| entry.file_name()))
            .collect::<std::io::Result<Vec<_>>>()?;
        names.retain(|name| {
            !["target", ".git", "node_modules"]
                .iter()
                .any(|skip| name == skip)
        });
        names.sort();
        names.hash(&mut hash);
    } else {
        match std::fs::read(path) {
            Ok(bytes) => bytes.hash(&mut hash),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        }
    }
    Ok(Some(hash.finish()))
}

pub struct Project {
    pub db: RootDatabase,
    pub vfs: Vfs,
    stamps: BTreeMap<PathBuf, Option<u64>>,
}

impl Project {
    pub fn load(root: &Path, settings: &Value) -> Result<Self> {
        let cargo = &settings["cargo"];
        if let Some(features) = cargo.get("features") {
            if !features.is_null()
                && features != "all"
                && !features.as_array().is_some_and(|features| {
                    features.iter().all(|feature| {
                        feature
                            .as_str()
                            .is_some_and(|name| !name.trim().is_empty() && !name.contains('\0'))
                    })
                })
            {
                bail!("cargo.features must be all or feature names");
            }
        }
        if let Some(value) = cargo.get("noDefaultFeatures") {
            if !value.is_null() && !value.is_boolean() {
                bail!("cargo.noDefaultFeatures must be boolean");
            }
        }
        if let Some(value) = cargo.get("target") {
            if !value.is_null()
                && !value
                    .as_str()
                    .is_some_and(|name| !name.trim().is_empty() && !name.contains('\0'))
            {
                bail!("cargo.target must be a target triple");
            }
        }
        let mut config = CargoConfig::default();
        config.sysroot = Some(RustLibSource::Discover);
        config.features = if cargo["features"] == "all" {
            CargoFeatures::All
        } else {
            CargoFeatures::Selected {
                features: cargo["features"]
                    .as_array()
                    .map(|rows| {
                        rows.iter()
                            .filter_map(|row| row.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default(),
                no_default_features: cargo["noDefaultFeatures"].as_bool().unwrap_or(false),
            }
        };
        config.target = cargo["target"].as_str().map(str::to_owned);
        config.metadata_extra_args = vec!["--locked".into()];
        config.extra_args = vec!["--locked".into()];
        let load = LoadCargoConfig {
            load_out_dirs_from_check: false,
            with_proc_macro_server: ProcMacroServerChoice::None,
            prefill_caches: false,
            num_worker_threads: 2,
            proc_macro_processes: 1,
        };
        let mut paths = std::collections::BTreeSet::new();
        let mut directories = vec![root.to_owned()];
        let mut count = 0;
        while let Some(directory) = directories.pop() {
            count += 1;
            if count > 20_000 {
                bail!("Rust workspace exceeds 20000 directories; select a narrower Cargo package");
            }
            paths.insert(directory.clone());
            for entry in std::fs::read_dir(&directory)? {
                let entry = entry?;
                let kind = entry.file_type()?;
                if kind.is_dir()
                    && !["target", ".git", "node_modules"]
                        .iter()
                        .any(|skip| entry.file_name() == *skip)
                {
                    directories.push(entry.path());
                } else if kind.is_file()
                    && [
                        "Cargo.toml",
                        "Cargo.lock",
                        "rust-toolchain",
                        "rust-toolchain.toml",
                    ]
                    .iter()
                    .any(|name| entry.file_name() == *name)
                {
                    paths.insert(entry.path());
                }
            }
        }
        for ancestor in root.ancestors() {
            for name in [
                "Cargo.toml",
                "Cargo.lock",
                "rust-toolchain",
                "rust-toolchain.toml",
                ".cargo/config.toml",
                ".cargo/config",
            ] {
                paths.insert(ancestor.join(name));
            }
        }
        let stamps = paths
            .into_iter()
            .map(|path| Ok((path.clone(), fingerprint(&path)?)))
            .collect::<Result<_>>()?;
        let (db, vfs, _) = load_workspace_at(root, &config, &load, &|_| {}).context(
            "Load Cargo workspace; prepare its lockfile/dependencies and matching toolchain first",
        )?;
        let mut project = Self { db, vfs, stamps };
        project.track_loaded_sources()?;
        if project.changed()? {
            bail!(
                "ContentModified: Rust source or Cargo configuration changed while loading the workspace"
            );
        }
        Ok(project)
    }

    fn track_loaded_sources(&mut self) -> Result<()> {
        for (id, path) in self.vfs.iter() {
            if let Some(path) = path.as_path() {
                let path = PathBuf::from(path.as_str());
                let stamp = if path.extension().is_some_and(|extension| extension == "rs") {
                    let mut hash = std::collections::hash_map::DefaultHasher::new();
                    self.db
                        .file_text(id)
                        .text(&self.db)
                        .as_bytes()
                        .hash(&mut hash);
                    Some(hash.finish())
                } else {
                    fingerprint(&path)?
                };
                self.stamps.insert(path.clone(), stamp);
                if let Some(parent) = path.parent() {
                    self.stamps
                        .entry(parent.to_owned())
                        .or_insert(fingerprint(parent)?);
                }
                if let Some(manifest) = path
                    .ancestors()
                    .skip(1)
                    .map(|directory| directory.join("Cargo.toml"))
                    .find(|file| file.is_file())
                {
                    self.stamps
                        .entry(manifest.clone())
                        .or_insert(fingerprint(&manifest)?);
                }
            }
        }
        Ok(())
    }

    pub fn changed(&self) -> Result<bool> {
        for (path, previous) in &self.stamps {
            if fingerprint(path)? != *previous {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub fn file(&self, path: &Path) -> Result<ra_ap_vfs::FileId> {
        let path = VfsPath::from(ra_ap_vfs::AbsPathBuf::assert_utf8(path.to_owned()));
        let (file, excluded) = self.vfs.file_id(&path).context("Rust file is outside loaded Cargo targets; check target, cfg/features and generated sources")?;
        if excluded == ra_ap_vfs::FileExcluded::Yes {
            bail!("Rust file is excluded from the loaded Cargo workspace");
        }
        Ok(file)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disk_edits_during_load_cannot_replace_the_database_source_snapshot() {
        let root = std::env::temp_dir().join(format!(
            "codex-lsp-rust-snapshot-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("source.rs");
        std::fs::write(&path, "const VALUE: u64 = 1;").unwrap();
        let mut project = Project {
            db: RootDatabase::default(),
            vfs: Vfs::default(),
            stamps: BTreeMap::new(),
        };
        let virtual_path = VfsPath::from(ra_ap_vfs::AbsPathBuf::assert_utf8(path.clone()));
        project.vfs.set_file_contents(
            virtual_path.clone(),
            Some(b"const VALUE: u32 = 1;".to_vec()),
        );
        let id = project.vfs.file_id(&virtual_path).unwrap().0;
        project.db.set_file_text(id, "const VALUE: u32 = 1;");
        project.track_loaded_sources().unwrap();
        assert!(project.changed().unwrap());
        std::fs::write(&path, "const VALUE: u32 = 1;").unwrap();
        assert!(!project.changed().unwrap());
        std::fs::remove_dir_all(root).unwrap();
    }
}
