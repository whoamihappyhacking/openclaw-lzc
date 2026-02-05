package recovery

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

type Recovery struct {
	configPath    string
	backupPath    string
	defaultConfig string
}

func New(configPath string, defaultConfig string) *Recovery {
	return &Recovery{
		configPath:    configPath,
		backupPath:    configPath + ".bak",
		defaultConfig: defaultConfig,
	}
}

// BackupConfig saves current config to backup file
func (r *Recovery) BackupConfig() error {
	data, err := os.ReadFile(r.configPath)
	if err != nil {
		return fmt.Errorf("failed to read config: %w", err)
	}

	backupPath := fmt.Sprintf("%s.bak.%d", r.configPath, time.Now().Unix())
	if err := os.WriteFile(backupPath, data, 0600); err != nil {
		return fmt.Errorf("failed to write backup: %w", err)
	}

	// Also update the main backup file
	if err := os.WriteFile(r.backupPath, data, 0600); err != nil {
		return fmt.Errorf("failed to write main backup: %w", err)
	}

	return nil
}

// RestoreBackup restores config from backup file
func (r *Recovery) RestoreBackup() error {
	data, err := os.ReadFile(r.backupPath)
	if err != nil {
		return fmt.Errorf("failed to read backup: %w", err)
	}

	// Try to validate JSON, but don't fail if invalid
	// User might want to restore anyway and fix manually
	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		// Log warning but continue with restore
		fmt.Printf("[recovery] Warning: backup file may have JSON issues: %v\n", err)
	}

	if err := os.WriteFile(r.configPath, data, 0600); err != nil {
		return fmt.Errorf("failed to write config: %w", err)
	}

	return nil
}

// RestoreDefault restores config from default template
func (r *Recovery) RestoreDefault() error {
	// Validate JSON
	var parsed map[string]any
	if err := json.Unmarshal([]byte(r.defaultConfig), &parsed); err != nil {
		return fmt.Errorf("default config is not valid JSON: %w", err)
	}

	// Ensure directory exists
	dir := filepath.Dir(r.configPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create config directory: %w", err)
	}

	if err := os.WriteFile(r.configPath, []byte(r.defaultConfig), 0600); err != nil {
		return fmt.Errorf("failed to write config: %w", err)
	}

	return nil
}

// HasBackup checks if backup file exists
func (r *Recovery) HasBackup() bool {
	_, err := os.Stat(r.backupPath)
	return err == nil
}

// GetConfigInfo returns info about config files
func (r *Recovery) GetConfigInfo() map[string]any {
	info := map[string]any{
		"configPath": r.configPath,
		"hasBackup":  r.HasBackup(),
	}

	if stat, err := os.Stat(r.configPath); err == nil {
		info["configModified"] = stat.ModTime().Unix()
		info["configSize"] = stat.Size()
	}

	if stat, err := os.Stat(r.backupPath); err == nil {
		info["backupModified"] = stat.ModTime().Unix()
		info["backupSize"] = stat.Size()
	}

	return info
}
