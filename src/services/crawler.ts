import axios, { AxiosRequestConfig } from 'axios';
import * as cheerio from 'cheerio';
import { CrawlJob } from '../types/crawler';
import { checkDomain } from './domainChecker';
import { useCrawlerStore } from '../store/crawlerStore';
import { retryWithBackoff } from '../utils/network';

const axiosConfig: AxiosRequestConfig = {
  timeout: 30000, // Increased timeout
  maxRedirects: 5,
  validateStatus: (status) => status < 500,
  headers: {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
  }
};

async function validateUrl(url: string): Promise<string> {
  try {
    let processedUrl = url.trim();
    if (!processedUrl.match(/^https?:\/\//i)) {
      processedUrl = `https://${processedUrl}`;
    }
    const parsedUrl = new URL(processedUrl);
    return parsedUrl.toString();
  } catch (error) {
    throw new Error('Invalid URL format. Please enter a valid URL.');
  }
}

async function testConnection(url: string): Promise<void> {
  const configs = [
    { ...axiosConfig },
    { ...axiosConfig, proxy: false }, // Try without proxy
    { 
      ...axiosConfig,
      headers: {
        ...axiosConfig.headers,
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    }
  ];

  let lastError;
  for (const config of configs) {
    try {
      await retryWithBackoff(() => axios.get(url, config), 3);
      return; // Connection successful
    } catch (error) {
      lastError = error;
      if (url.startsWith('https://')) {
        try {
          const httpUrl = url.replace('https://', 'http://');
          await retryWithBackoff(() => axios.get(httpUrl, config), 3);
          return; // HTTP connection successful
        } catch (httpError) {
          lastError = httpError;
        }
      }
    }
  }
  
  throw new Error(`Cannot connect to ${url}. Error: ${lastError?.message || 'Unknown error'}`);
}

export async function startCrawl(url: string): Promise<void> {
  const jobId = Date.now().toString();
  const job: CrawlJob = {
    id: jobId,
    url,
    status: 'running',
    progress: 0,
    crawledUrls: [],
    externalLinks: [],
    expiredDomains: [],
    startTime: new Date(),
  };

  useCrawlerStore.getState().addJob(job);

  try {
    const validatedUrl = await validateUrl(url);
    const visited = new Set<string>();
    const queue = [validatedUrl];
    
    await testConnection(validatedUrl);
    
    while (queue.length > 0 && useCrawlerStore.getState().activeJobs.includes(jobId)) {
      const currentUrl = queue.shift()!;
      
      if (visited.has(currentUrl)) continue;
      visited.add(currentUrl);

      try {
        const response = await retryWithBackoff(
          () => axios.get(currentUrl, axiosConfig),
          3
        );
        
        const contentType = response.headers['content-type'] || '';
        if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml')) {
          const $ = cheerio.load(response.data);
          
          $('a').each((_, element) => {
            const href = $(element).attr('href');
            if (!href) return;

            try {
              const absoluteUrl = new URL(href, currentUrl).toString();
              const isExternal = !absoluteUrl.includes(new URL(validatedUrl).hostname);

              if (isExternal) {
                const externalDomain = new URL(absoluteUrl).hostname;
                if (!job.externalLinks.some(link => link.url === absoluteUrl)) {
                  job.externalLinks.push({
                    url: absoluteUrl,
                    statusCode: response.status,
                  });

                  checkDomain(externalDomain)
                    .then((domainCheck) => {
                      if (domainCheck.isExpired && 
                          !job.expiredDomains.some(d => d.domain === domainCheck.domain)) {
                        job.expiredDomains.push(domainCheck);
                        useCrawlerStore.getState().updateJob(jobId, {
                          ...job,
                          expiredDomains: [...job.expiredDomains]
                        });
                      }
                    })
                    .catch((error) => {
                      console.error(`Error checking domain ${externalDomain}:`, error);
                    });
                }
              } else if (!visited.has(absoluteUrl)) {
                queue.push(absoluteUrl);
              }
            } catch (urlError) {
              console.debug('Invalid URL:', href);
            }
          });
        }

        job.crawledUrls = [...job.crawledUrls, currentUrl];
        job.progress = (job.crawledUrls.length / (job.crawledUrls.length + queue.length)) * 100;
        
        useCrawlerStore.getState().updateJob(jobId, {
          ...job,
          crawledUrls: [...job.crawledUrls],
          progress: job.progress
        });
      } catch (error) {
        console.error(`Error crawling ${currentUrl}:`, error);
        job.crawledUrls.push(`${currentUrl} (Failed: ${error.message})`);
        useCrawlerStore.getState().updateJob(jobId, {
          ...job,
          crawledUrls: [...job.crawledUrls]
        });
      }
    }

    job.status = 'completed';
    job.endTime = new Date();
    useCrawlerStore.getState().updateJob(jobId, job);
  } catch (error) {
    console.error('Crawl error:', error);
    job.status = 'error';
    job.error = error.message;
    job.endTime = new Date();
    useCrawlerStore.getState().updateJob(jobId, job);
  }
}