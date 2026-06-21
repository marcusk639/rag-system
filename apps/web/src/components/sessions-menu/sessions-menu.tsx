import React from "react";
import { History, Plus } from "lucide-react";
import type { ChatSession } from "@/types";

interface SessionsMenuProps {
  sessions: ChatSession[];
  currentSession: ChatSession;
  onNewSession: () => void;
  onSwitchSession: (session: ChatSession) => void;
  isOpen: boolean;
  onClose: () => void;
}

export const SessionsMenu: React.FC<SessionsMenuProps> = ({
  sessions,
  currentSession,
  onNewSession,
  onSwitchSession,
  isOpen,
}) => {
  if (!isOpen) return null;

  return (
    <div className="absolute right-0 top-12 w-64 bg-white rounded-lg shadow-lg border border-gray-200 z-50">
      <div className="p-2">
        <button
          onClick={onNewSession}
          className="w-full flex items-center space-x-2 p-2 hover:bg-gray-50 rounded"
        >
          <Plus size={18} />
          <span>New Chat Session</span>
        </button>
        <div className="border-t my-2" />
        {sessions.map((session) => (
          <button
            key={session.id}
            onClick={() => onSwitchSession(session)}
            className={`w-full flex items-center justify-between p-2 hover:bg-gray-50 rounded ${
              currentSession.id === session.id ? "bg-blue-50" : ""
            }`}
          >
            <div className="flex flex-col items-start">
              <span className="font-medium">{session.name}</span>
              <span className="text-xs text-gray-500">
                {session.messages.length} messages
              </span>
            </div>
            <History size={16} className="text-gray-400" />
          </button>
        ))}
      </div>
    </div>
  );
};
