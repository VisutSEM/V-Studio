mod ai;
mod commands;
mod db;
mod error;
mod pipeline;
mod planner;
mod render;
mod settings;
mod subs;

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

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            settings::get_settings,
            settings::save_settings,
            settings::test_llm,
            settings::test_image,
            settings::test_tts,
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

    app.run(|_app_handle, _event| {});
}
