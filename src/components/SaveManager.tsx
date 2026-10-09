import { useState } from 'react';
import type { GameState } from '../engine/types';
import { listSaves, saveGame, loadGame, deleteSave } from '../engine/persistence';
import type { SaveSlot } from '../engine/persistence';
import { Save, FolderOpen, Trash2, X } from 'lucide-react';

interface Props {
  state: GameState;
  dataSource: string;
  onLoad: (state: GameState) => void;
}

export default function SaveManager({ state, dataSource, onLoad }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [saves, setSaves] = useState<SaveSlot[]>([]);
  const [saveName, setSaveName] = useState('');
  const [message, setMessage] = useState('');

  const openPanel = () => {
    setSaves(listSaves());
    setIsOpen(true);
    setMessage('');
  };

  const handleSave = () => {
    const name = saveName.trim() || `Session ${new Date().toLocaleDateString()}`;
    saveGame(state, name, dataSource);
    setSaves(listSaves());
    setSaveName('');
    setMessage(`Saved "${name}"`);
    setTimeout(() => setMessage(''), 2000);
  };

  const handleLoad = (id: string) => {
    const loaded = loadGame(id);
    if (loaded) {
      onLoad(loaded);
      setIsOpen(false);
    }
  };

  const handleDelete = (id: string) => {
    deleteSave(id);
    setSaves(listSaves());
  };

  return (
    <>
      <button className="btn btn-save-toggle" onClick={openPanel}>
        <Save size={16} /> Save/Load
      </button>

      {isOpen && (
        <div className="modal-overlay" onClick={() => setIsOpen(false)}>
          <div className="modal save-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Save & Load</h2>
              <button className="btn btn-icon" onClick={() => setIsOpen(false)}><X size={18} /></button>
            </div>

            {/* Save current */}
            <div className="save-current">
              <h4>Save Current Session</h4>
              <div className="save-form">
                <input
                  type="text"
                  className="input"
                  placeholder="Session name (optional)"
                  value={saveName}
                  onChange={e => setSaveName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleSave()}
                />
                <button className="btn btn-buy" onClick={handleSave}>
                  <Save size={14} /> Save
                </button>
              </div>
              {message && <div className="save-message">{message}</div>}
            </div>

            {/* Saved sessions */}
            <div className="save-list-section">
              <h4>Saved Sessions ({saves.length})</h4>
              {saves.length === 0 ? (
                <div className="empty-state">No saved sessions yet.</div>
              ) : (
                <div className="save-list">
                  {saves.map(s => (
                    <div key={s.id} className="save-item">
                      <div className="save-item-info">
                        <div className="save-item-name">{s.name}</div>
                        <div className="save-item-meta">
                          <span>{s.date}</span>
                          <span className={s.netProfit >= 0 ? 'positive' : 'negative'}>
                            {s.netProfit >= 0 ? '+' : ''}£{s.netProfit.toFixed(2)}
                          </span>
                          <span>{s.totalCycles} cycles</span>
                          <span className={`data-badge-sm ${s.dataSource}`}>
                            {s.dataSource === 'live' ? 'LIVE' : 'SYN'}
                          </span>
                        </div>
                        <div className="save-item-time">
                          {new Date(s.savedAt).toLocaleString()}
                        </div>
                      </div>
                      <div className="save-item-actions">
                        <button className="btn btn-sm" onClick={() => handleLoad(s.id)}>
                          <FolderOpen size={14} /> Load
                        </button>
                        <button className="btn btn-sm btn-danger-sm" onClick={() => handleDelete(s.id)}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
