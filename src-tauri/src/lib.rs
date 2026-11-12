mod ai;
mod assembler;
mod audio_post;
mod commands;
mod db;
mod error;
mod pipeline;
mod planner;
mod render;
mod scene_parser;
mod settings;
mod subs;
mod tts_router;
pub mod voxcpm;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let pool = tauri::async_runtime::block_on(db::init(&dir))?;
            app.manage(db::AppState { pool, dir });

            // Start the local VoxCPM 2 server only when the router actually
            // selected it and the URL points at this machine.
            let vox = voxcpm::VoxCpmManager::new();
            app.manage(vox.clone());
            let s = settings::load(app.handle());
            let route = tts_router::resolve(&s);
            let local_url = voxcpm::is_local_url(&voxcpm::configured_base_url(&s));
            if route.engine == settings::TtsKind::VoxCpm && local_url {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let _ = vox.start_background(app_handle).await;
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            settings::get_settings,
            settings::save_settings,
            settings::test_llm,
            settings::test_image,
            settings::test_tts,
            tts_router::get_tts_route,
            tts_router::get_gpu_info,
            voxcpm::get_voxcpm_status,
            voxcpm::get_voxcpm_setup_status,
            voxcpm::setup_voxcpm_engine,
            voxcpm::start_voxcpm_server,
            voxcpm::stop_voxcpm_server,
            voxcpm::check_voxcpm_health,
            voxcpm::verify_voxcpm_model,
            voxcpm::delete_voxcpm_model,
            commands::create_project,
            commands::update_project,
            commands::list_projects,
            commands::list_project_cards,
            commands::get_project,
            commands::delete_project,
            commands::estimate,
            commands::clear_asset,
            commands::build_subtitles,
            commands::get_subtitles,
            commands::save_subtitles,
            commands::rename_project,
            commands::update_project_story,
            commands::update_scene,
            commands::add_scene,
            commands::delete_scene,
            commands::save_scene_recording,
            commands::check_for_updates,
            pipeline::generate_script,
            pipeline::generate_voice,
            pipeline::generate_images,
            pipeline::generate_scene_voice,
            pipeline::generate_scene_image,
            render::render_video,
            render::export_video,
            render::open_output_dir,
        ]);

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(vox) = app_handle.try_state::<voxcpm::VoxCpmManager>() {
                vox.stop();
            }
        }
    });
}
