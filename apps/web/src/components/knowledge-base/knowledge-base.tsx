"use client";

import React, { useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import UploadModal from "@/components/upload-modal";
import SessionsMenu from "@/components/sessions-menu";
import DocumentList from "@/components/document-list";
import ChatInterface from "@/components/chat-interface";
import { useDocuments } from "@/hooks/use-documents";
import { useChatSessions } from "@/hooks/use-chat-sessions";
import type { Citation } from "@/types";

export const KnowledgeBase = () => {
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [activeCitation, setActiveCitation] = useState<Citation | null>(null);

  const { sources, selectedSource, toggleSource, loading, error } =
    useDocuments();
  const {
    sessions,
    currentSession,
    createNewSession,
    switchSession,
    addMessage,
    updateMessage,
  } = useChatSessions();

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white shadow-sm p-4">
        <div className="max-w-7xl mx-auto">
          <h1 className="text-xl font-semibold text-gray-800">
            RAG Knowledge Hub
          </h1>
        </div>
      </nav>

      <div className="max-w-7xl mx-auto p-6">
        <div className="flex gap-6">
          <div className="w-[50%]">
            <div className="mb-6 flex justify-between items-center">
              <h2 className="text-lg font-medium text-gray-700">Sources</h2>
              <button
                onClick={() => setUploadModalOpen(true)}
                className="flex items-center space-x-2 bg-blue-500 text-white px-6 py-2 rounded hover:bg-blue-600"
              >
                <Plus size={20} />
                <span>Upload</span>
              </button>
            </div>

            <DocumentList
              sources={sources}
              selectedSource={selectedSource}
              onSourceSelect={toggleSource}
              loading={loading}
              error={error}
            />
          </div>

          <div className="w-[50%]">
            <Card className="h-[calc(100vh-8rem)] flex flex-col">
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-lg font-medium">
                  AI Assistant
                </CardTitle>
                <div className="relative">
                  <button
                    onClick={() => setSessionMenuOpen(!sessionMenuOpen)}
                    className="flex items-center space-x-2 text-gray-600 hover:text-gray-800"
                  >
                    <RefreshCw size={18} />
                    <span className="text-sm">Sessions</span>
                  </button>
                  {sessionMenuOpen && (
                    <SessionsMenu
                      isOpen={sessionMenuOpen}
                      sessions={sessions}
                      currentSession={currentSession}
                      onNewSession={createNewSession}
                      onSwitchSession={switchSession}
                      onClose={() => setSessionMenuOpen(false)}
                    />
                  )}
                </div>
              </CardHeader>
              <ChatInterface
                session={currentSession}
                selectedSource={selectedSource}
                addMessage={addMessage}
                updateMessage={updateMessage}
                onCitationClick={setActiveCitation}
              />
            </Card>
          </div>
        </div>
      </div>

      {uploadModalOpen && (
        <UploadModal onClose={() => setUploadModalOpen(false)} />
      )}

      {activeCitation && (
        <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50">
          <Card className="w-full max-w-lg">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base">
                [{activeCitation.index}] {activeCitation.title}
              </CardTitle>
              <button
                onClick={() => setActiveCitation(null)}
                className="text-gray-500 hover:text-gray-700"
              >
                Close
              </button>
            </CardHeader>
            <div className="p-6 pt-0 text-sm text-gray-600">
              {activeCitation.url ? (
                <a
                  href={activeCitation.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:underline"
                >
                  Open source document
                </a>
              ) : (
                <span>Document id: {activeCitation.documentId}</span>
              )}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
};
