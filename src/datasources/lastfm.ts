import { lastFm } from '@/clients';
import schedule from 'node-schedule';
import debug from 'debug';
import config from '@/config';
import { WeeklyAlbum, Artist, Album } from 'lastfm-nodejs-client/dist/@types/lastfm.types';

const DEBUG = debug('services:datasources:lastfm');

let top: { weeklyAlbum: WeeklyAlbum[], weeklyArtist: Artist[], album: Album[], artist: Artist[] } = {
  weeklyAlbum: [],
  weeklyArtist: [],
  album: [],
  artist: [],
};

export function getTopMusic() {
  return top;
}

export async function lastFmUpdate() {
  DEBUG('Updating Lastfm.');
  const [topAlbums, topArtists, weeklyTopAblums, weeklyTopArtists] = await Promise.all([
    lastFm.getTopAlbums(
      lastFm.method.user.getTopAlbums,
      config.lastFm.username,
      'overall',
      '8',
    ),
    lastFm.getTopArtists(
      lastFm.method.user.getTopArtists,
      config.lastFm.username,
      'overall',
      '8',
    ),
    lastFm.getWeeklyAlbumChart(
      lastFm.method.user.getWeeklyAlbumChart,
      config.lastFm.username,
      'overall',
      '8',
    ),
    lastFm.getWeeklyArtistChart(
      lastFm.method.user.getWeeklyArtistChart,
      config.lastFm.username,
      'overall',
      '8',
    ),
  ]);
  top.album = topAlbums.topalbums.album;
  top.artist = topArtists.topartists.artist;
  top.weeklyAlbum = weeklyTopAblums.weeklyalbumchart.album;
  top.weeklyArtist = weeklyTopArtists.weeklyartistchart.artist;
  DEBUG('Updated Lastfm.');
}

export async function scheduleLastFmUpdate() {
  await lastFmUpdate();
  schedule.scheduleJob('8 * * * *', lastFmUpdate);
}