import React, { createContext, useCallback, useContext, useEffect, useState, ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NOTIFICATION_STORAGE_KEY } from '@/config';
import { useAuth } from '@/contexts/AuthContext';
import { isManagerRole, type Notification, type RiskLevel } from '@/types';
import { api } from '@/api/client';

interface NotificationContextType {
  notifications: Notification[];
  unreadCount: number;
  markRead: (id: string) => void;
  markAllRead: () => void;
  pushLocal: (n: Omit<Notification, 'id' | 'read' | 'createdAt' | 'source' | 'alertId'> & { riskLevel: RiskLevel | null }) => void;
  refreshRemote: () => Promise<void>;
}

const NotificationContext = createContext<NotificationContextType>({
  notifications: [],
  unreadCount: 0,
  markRead: () => {},
  markAllRead: () => {},
  pushLocal: () => {},
  refreshRemote: async () => {},
});

function sortByTime(list: Notification[]): Notification[] {
  return [...list].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function NotificationProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, role } = useAuth();
  const [notifications, setNotifications] = useState<Notification[]>([]);

  useEffect(() => {
    AsyncStorage.getItem(NOTIFICATION_STORAGE_KEY).then((raw) => {
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw) as Notification[];
        if (Array.isArray(parsed)) setNotifications(parsed);
      } catch {
        // ignore corrupt cache
      }
    });
  }, []);

  useEffect(() => {
    AsyncStorage.setItem(NOTIFICATION_STORAGE_KEY, JSON.stringify(notifications)).catch(() => {});
  }, [notifications]);

  const refreshRemote = useCallback(async () => {
    if (!isAuthenticated || !isManagerRole(role)) return;
    try {
      const alerts = await api.managerAlerts();
      setNotifications((prev) => {
        const localOnly = prev.filter((n) => n.source === 'local-scan');
        const fromAlerts: Notification[] = alerts.map((a) => ({
          id: `alert:${a.id}`,
          title: a.title,
          body: a.body,
          riskLevel: a.type as RiskLevel,
          createdAt: a.created_at,
          read: a.acknowledged,
          source: 'manager-alert',
          alertId: a.id,
        }));
        return sortByTime([...localOnly, ...fromAlerts]);
      });
    } catch {
      // keep last known
    }
  }, [isAuthenticated, role]);

  useEffect(() => {
    refreshRemote();
  }, [refreshRemote]);

  useEffect(() => {
    const interval = setInterval(() => {
      refreshRemote();
    }, 30000);
    return () => clearInterval(interval);
  }, [refreshRemote]);

  const markRead = (id: string) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
  };

  const markAllRead = () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  };

  const pushLocal: NotificationContextType['pushLocal'] = (n) => {
    const item: Notification = {
      id: `local:${Date.now()}`,
      title: n.title,
      body: n.body,
      riskLevel: n.riskLevel,
      createdAt: new Date().toISOString(),
      read: false,
      source: 'local-scan',
      alertId: null,
    };
    setNotifications((prev) => sortByTime([item, ...prev]).slice(0, 50));
  };

  const unreadCount = notifications.filter((n) => !n.read).length;

  return (
    <NotificationContext.Provider
      value={{ notifications, unreadCount, markRead, markAllRead, pushLocal, refreshRemote }}
    >
      {children}
    </NotificationContext.Provider>
  );
}

export const useNotifications = () => useContext(NotificationContext);
