import pool from '../db.js';
import { tiktokLiveService } from './tiktokLiveService.js';

/**
 * Bot Context Service
 * Aggregates ALL available data (real-time + historical) for AI character responses
 */
export const botContextService = {
  /**
   * Get complete context for a TikTok stream
   * Used to provide comprehensive data to Inworld AI
   */
  async getStreamContext(tiktokUsername) {
    try {
      const streamStatus = tiktokLiveService.getStreamStatus(tiktokUsername);
      if (!streamStatus || !streamStatus.isConnected) {
        return null;
      }

      // Colectar datos en vivo
      const liveData = this.getLiveStreamData(tiktokUsername);

      // Colectar datos históricos de BD
      // Primero necesitamos el user_id del streamer
      // Por ahora retornamos estructura, será mejorado cuando tengamos user_id

      return {
        stream: {
          tiktok_username: tiktokUsername,
          is_connected: streamStatus.isConnected,
          viewer_count: liveData.viewerCount || 0,
          total_likes: liveData.totalLikes || 0,
          message_count: streamStatus.messageCount || 0,
          duration_seconds: Math.floor((Date.now() - streamStatus.startTime) / 1000),
          start_time: streamStatus.startTime
        },
        engagement: {
          total_messages: streamStatus.messageCount || 0,
          total_donors: liveData.donors.size || 0,
          total_followers: liveData.followers.size || 0,
          total_gifts_sent: liveData.totalGiftsSent || 0,
          unique_gift_names: Array.from(liveData.uniqueGifts || [])
        },
        top_contributors: {
          top_donors: this.getTopDonors(liveData.donorsList, 5),
          top_commenters: this.getTopCommenters(liveData.messageMap, 5),
          recent_followers: Array.from(liveData.followers || []).slice(0, 10)
        },
        user_metadata: {
          moderators: liveData.moderators || [],
          subscribers: liveData.subscribers || [],
          top_gifters: liveData.topGifters || [],
          donors: Array.from(liveData.donors || [])
        }
      };
    } catch (err) {
      console.error('[BotContext] Error getting stream context:', err);
      return null;
    }
  },

  /**
   * Get live stream data from TikTok connection
   */
  getLiveStreamData(tiktokUsername) {
    const activeStreams = tiktokLiveService.getActiveStreams();
    const streamData = activeStreams.find(s => s.username === tiktokUsername);

    if (!streamData || !streamData.tiktokConnection) {
      return {
        viewerCount: 0,
        totalLikes: 0,
        donors: new Set(),
        donorsList: [],
        followers: new Set(),
        totalGiftsSent: 0,
        uniqueGifts: new Set(),
        moderators: [],
        subscribers: [],
        topGifters: [],
        messageMap: new Map()
      };
    }

    // Extraer datos del connection
    const connection = streamData.tiktokConnection;
    const roomData = connection.roomData || {};

    return {
      viewerCount: roomData.viewerCount || 0,
      totalLikes: roomData.likeCount || 0,
      donors: connection.donors || new Set(),
      donorsList: this.aggregateDonorData(connection.messages || []),
      followers: connection.followers || new Set(),
      totalGiftsSent: this.countTotalGifts(connection.messages || []),
      uniqueGifts: this.getUniqueGiftNames(connection.messages || []),
      moderators: this.extractModerators(connection.messages || []),
      subscribers: this.extractSubscribers(connection.messages || []),
      topGifters: this.getTopGifters(connection.messages || []),
      messageMap: this.buildMessageMap(connection.messages || [])
    };
  },

  /**
   * Aggregate donor data with gift counts
   */
  aggregateDonorData(messages) {
    const donorMap = new Map();

    messages.forEach(msg => {
      if (msg.type === 'gift') {
        if (!donorMap.has(msg.username)) {
          donorMap.set(msg.username, {
            username: msg.username,
            gift_count: 0,
            gifts: []
          });
        }
        const donor = donorMap.get(msg.username);
        donor.gift_count += (msg.repeatCount || 1);
        if (msg.giftName && !donor.gifts.includes(msg.giftName)) {
          donor.gifts.push(msg.giftName);
        }
      }
    });

    return Array.from(donorMap.values())
      .sort((a, b) => b.gift_count - a.gift_count);
  },

  /**
   * Get top donors
   */
  getTopDonors(donorsList, limit = 5) {
    return donorsList.slice(0, limit).map(d => ({
      username: d.username,
      gift_count: d.gift_count,
      gifts: d.gifts
    }));
  },

  /**
   * Count total gifts sent
   */
  countTotalGifts(messages) {
    return messages.reduce((sum, msg) => {
      if (msg.type === 'gift') {
        return sum + (msg.repeatCount || 1);
      }
      return sum;
    }, 0);
  },

  /**
   * Get unique gift names
   */
  getUniqueGiftNames(messages) {
    const gifts = new Set();
    messages.forEach(msg => {
      if (msg.type === 'gift' && msg.giftName) {
        gifts.add(msg.giftName);
      }
    });
    return gifts;
  },

  /**
   * Extract moderators from messages
   */
  extractModerators(messages) {
    const mods = new Set();
    messages.forEach(msg => {
      if (msg.isModerator && msg.username) {
        mods.add(msg.username);
      }
    });
    return Array.from(mods);
  },

  /**
   * Extract subscribers
   */
  extractSubscribers(messages) {
    const subs = new Set();
    messages.forEach(msg => {
      if (msg.isSubscriber && msg.username) {
        subs.add(msg.username);
      }
    });
    return Array.from(subs);
  },

  /**
   * Get top gifters
   */
  getTopGifters(messages) {
    const gifterMap = new Map();
    messages.forEach(msg => {
      if (msg.type === 'gift' && msg.username) {
        if (!gifterMap.has(msg.username)) {
          gifterMap.set(msg.username, 0);
        }
        gifterMap.set(msg.username, gifterMap.get(msg.username) + (msg.repeatCount || 1));
      }
    });

    return Array.from(gifterMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([username]) => username);
  },

  /**
   * Build message count map
   */
  buildMessageMap(messages) {
    const msgMap = new Map();
    messages.forEach(msg => {
      if (msg.type === 'chat' || msg.type === 'message') {
        if (!msgMap.has(msg.username)) {
          msgMap.set(msg.username, 0);
        }
        msgMap.set(msg.username, msgMap.get(msg.username) + 1);
      }
    });
    return msgMap;
  },

  /**
   * Get top commenters
   */
  getTopCommenters(messageMap, limit = 5) {
    return Array.from(messageMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([username, count]) => ({
        username,
        message_count: count
      }));
  },

  /**
   * Format context for Inworld system prompt injection
   * Makes the context readable for AI prompt
   */
  formatContextForInworld(context) {
    if (!context) return '';

    const {
      stream,
      engagement,
      top_contributors,
      user_metadata
    } = context;

    const topDonorsText = top_contributors.top_donors
      .map((d, i) => `${i + 1}. ${d.username} - ${d.gift_count} gifts`)
      .join('\n');

    const topCommentersText = top_contributors.top_commenters
      .map((c, i) => `${i + 1}. ${c.username} - ${c.message_count} messages`)
      .join('\n');

    return `
STREAM CONTEXT:
- Username: ${stream.tiktok_username}
- Current Viewers: ${stream.viewer_count}
- Total Likes: ${stream.total_likes}
- Stream Duration: ${stream.duration_seconds}s
- Total Messages: ${stream.message_count}

ENGAGEMENT STATS:
- Total Donors: ${engagement.total_donors}
- Total Followers: ${engagement.total_followers}
- Total Gifts Sent: ${engagement.total_gifts_sent}

TOP CONTRIBUTORS:
${topDonorsText}

TOP COMMENTERS:
${topCommentersText}

RECENT FOLLOWERS:
${top_contributors.recent_followers.join(', ')}

MODERATORS: ${user_metadata.moderators.join(', ')}
SUBSCRIBERS: ${user_metadata.subscribers.length > 0 ? user_metadata.subscribers.slice(0, 5).join(', ') : 'None'}
`;
  }
};

export default botContextService;
