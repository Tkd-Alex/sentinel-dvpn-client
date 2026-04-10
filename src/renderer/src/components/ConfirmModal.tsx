import React from 'react'

interface Props {
  title:       string
  message:     React.ReactNode
  confirmLabel?: string
  cancelLabel?:  string
  danger?:     boolean
  onConfirm:   () => void
  onCancel:    () => void
}

export default function ConfirmModal({
  title, message,
  confirmLabel = 'Confirm', cancelLabel = 'Cancel',
  danger = false, onConfirm, onCancel
}: Props) {
  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onCancel() }}>
      <div className="confirm-modal">
        <div className="confirm-icon">{danger ? '⚠' : 'ⓘ'}</div>
        <div className="confirm-title">{title}</div>
        <div className="confirm-message">{message}</div>
        <div className="confirm-actions">
          {cancelLabel !== "" && (
            <button className="btn btn-secondary" style={{ flex: 1 }} onClick={onCancel}>
              {cancelLabel}
            </button>
          )}
          {confirmLabel !== "" && (
            <button
              className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
              style={{ flex: 1 }}
              onClick={onConfirm}
            >
              {confirmLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
